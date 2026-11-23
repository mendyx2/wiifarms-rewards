import { audit, type Actor } from "../audit.ts";
import type { Ctx } from "../context.ts";
import { lockKey, one, withTx } from "../db.ts";
import { badRequest, conflict, forbidden, notFound } from "../errors.ts";
import { adminActor, requireRole, type Admin } from "./admin.ts";
import { normalisePhone, type User } from "./identity.ts";
import { notify } from "./notify.ts";
import { winningsBalance } from "./wallet.ts";

/**
 * Customer support.
 *
 * Players raise requests in the app and see staff replies there; a text tells
 * them a reply is waiting but never carries the reply itself. Support staff see
 * what they need to help — never full phone, identity or bank numbers, and
 * never unrevealed outcomes — and every look at a player's record is audited.
 *
 * Deliberately NOT possible for support: resetting a PIN, changing a phone
 * number, raising a limit, or moving money. Those are what someone pretending
 * to be the player would ask for. The player resets their own PIN with a code
 * sent to their own phone.
 *
 * Support can lock an account at once on a suspected takeover. Unlocking needs
 * a Compliance officer who is not the person who locked it.
 */

export type Topic = "PAYMENT" | "PRIZE" | "ACCOUNT" | "TECHNICAL" | "COMPLAINT" | "OTHER";
const MAX_OPEN_PER_PLAYER = 5;
const VIEW: Parameters<typeof requireRole>[1][] = ["SUPPORT", "COMPLIANCE", "AUDITOR"];

const clean = (s: string, max = 2000): string => {
  const t = s.trim();
  if (!t) throw badRequest("MESSAGE_REQUIRED", "Write a message.");
  if (t.length > max) throw badRequest("MESSAGE_TOO_LONG", `Please keep it under ${max} characters.`);
  return t;
};

// --- Player side ------------------------------------------------------------------------------

export async function openTicket(ctx: Ctx, actor: Actor, user: User, input: { topic: Topic; subject: string; message: string }): Promise<{ id: string }> {
  const subject = clean(input.subject, 120), message = clean(input.message);
  return withTx(ctx.pool, async (db) => {
    await lockKey(db, `support:${user.id}`);
    const open = (await one<{ n: number }>(db, "SELECT count(*)::int AS n FROM support_tickets WHERE user_id = $1 AND status <> 'CLOSED'", [user.id]))!.n;
    if (open >= MAX_OPEN_PER_PLAYER) throw conflict("TOO_MANY_OPEN", "You already have several open requests. Please add to one of those, and we will answer it.");
    const t = await db.query<{ id: string }>("INSERT INTO support_tickets (user_id, topic, subject) VALUES ($1, $2, $3) RETURNING id", [user.id, input.topic, subject]);
    await db.query("INSERT INTO support_messages (ticket_id, author, body) VALUES ($1, 'PLAYER', $2)", [t.rows[0]!.id, message]);
    // A complaint goes to Compliance as well as to support, as gaming regulators usually require.
    if (input.topic === "COMPLAINT") {
      await db.query("UPDATE support_tickets SET escalated = true WHERE id = $1", [t.rows[0]!.id]);
      await db.query("INSERT INTO compliance_alerts (kind, severity, entity_type, entity_id, details) VALUES ('PLAYER_COMPLAINT', 'WARNING', 'support_ticket', $1, $2)",
        [t.rows[0]!.id, JSON.stringify({ subject })]);
    }
    await audit(db, actor, "support.ticket_opened", "support_ticket", t.rows[0]!.id, { topic: input.topic });
    return { id: t.rows[0]!.id };
  });
}

export async function playerTickets(ctx: Ctx, userId: string): Promise<unknown[]> {
  const tickets = (await ctx.pool.query(
    "SELECT id, topic, subject, status, created_at, updated_at FROM support_tickets WHERE user_id = $1 ORDER BY (status = 'CLOSED'), updated_at DESC LIMIT 50", [userId])).rows;
  const messages = (await ctx.pool.query(
    // Staff are shown to players by role, not by name.
    `SELECT m.ticket_id, m.author, m.body, m.created_at FROM support_messages m JOIN support_tickets t ON t.id = m.ticket_id
     WHERE t.user_id = $1 ORDER BY m.id`, [userId])).rows as { ticket_id: string }[];
  return tickets.map((t) => ({ ...t, messages: messages.filter((m) => m.ticket_id === t.id) }));
}

export async function playerReply(ctx: Ctx, actor: Actor, user: User, ticketId: string, message: string): Promise<{ status: string }> {
  const body = clean(message);
  return withTx(ctx.pool, async (db) => {
    const t = await one<{ status: string }>(db, "SELECT status FROM support_tickets WHERE id = $1 AND user_id = $2 FOR UPDATE", [ticketId, user.id]);
    if (!t) throw notFound("Request not found.");
    if (t.status === "CLOSED") throw conflict("TICKET_CLOSED", "This request is closed. Please start a new one.");
    await db.query("INSERT INTO support_messages (ticket_id, author, body) VALUES ($1, 'PLAYER', $2)", [ticketId, body]);
    await db.query("UPDATE support_tickets SET status = 'OPEN', updated_at = now() WHERE id = $1", [ticketId]);
    await audit(db, actor, "support.player_replied", "support_ticket", ticketId);
    return { status: "OPEN" };
  });
}

// --- Staff side --------------------------------------------------------------------------------

export async function queue(ctx: Ctx, admin: Admin, status?: string): Promise<unknown[]> {
  requireRole(admin, ...VIEW);
  return (await ctx.pool.query(
    `SELECT t.id, t.topic, t.subject, t.status, t.escalated, t.created_at, t.updated_at, '…' || right(u.phone_e164, 4) AS player_phone, u.full_name AS player_name,
            (SELECT count(*) FROM support_messages m WHERE m.ticket_id = t.id)::int AS messages,
            (SELECT m.author FROM support_messages m WHERE m.ticket_id = t.id ORDER BY m.id DESC LIMIT 1) AS last_author
     FROM support_tickets t JOIN users u ON u.id = t.user_id
     WHERE ($1::text IS NULL OR t.status = $1) ORDER BY (t.status = 'CLOSED'), t.escalated DESC, t.updated_at LIMIT 200`, [status ?? null])).rows;
}

export async function ticketDetail(ctx: Ctx, admin: Admin, ticketId: string): Promise<unknown> {
  requireRole(admin, ...VIEW);
  const t = await one<Record<string, unknown> & { user_id: string }>(ctx.pool,
    `SELECT t.*, '…' || right(u.phone_e164, 4) AS player_phone, u.full_name AS player_name FROM support_tickets t JOIN users u ON u.id = t.user_id WHERE t.id = $1`, [ticketId]);
  if (!t) throw notFound("Request not found.");
  const messages = (await ctx.pool.query(
    `SELECT m.author, m.body, m.created_at, a.full_name AS staff_name FROM support_messages m LEFT JOIN admin_users a ON a.id = m.admin_user_id WHERE m.ticket_id = $1 ORDER BY m.id`, [ticketId])).rows;
  return { ...t, messages };
}

export async function staffReply(ctx: Ctx, admin: Admin, ticketId: string, input: { message: string; close?: boolean }): Promise<{ status: string }> {
  requireRole(admin, "SUPPORT", "COMPLIANCE");
  const body = clean(input.message);
  return withTx(ctx.pool, async (db) => {
    const t = await one<{ status: string; user_id: string; subject: string }>(db, "SELECT status, user_id, subject FROM support_tickets WHERE id = $1 FOR UPDATE", [ticketId]);
    if (!t) throw notFound("Request not found.");
    if (t.status === "CLOSED") throw conflict("TICKET_CLOSED", "This request is closed.");
    await db.query("INSERT INTO support_messages (ticket_id, author, admin_user_id, body) VALUES ($1, 'STAFF', $2, $3)", [ticketId, admin.id, body]);
    const status = input.close ? "CLOSED" : "WAITING_PLAYER";
    await db.query(`UPDATE support_tickets SET status = $2, updated_at = now(), closed_at = CASE WHEN $2 = 'CLOSED' THEN now() END, closed_by = CASE WHEN $2 = 'CLOSED' THEN $3::uuid END WHERE id = $1`,
      [ticketId, status, admin.id]);
    const n = (await one<{ n: number }>(db, "SELECT count(*)::int AS n FROM support_messages WHERE ticket_id = $1", [ticketId]))!.n;
    // The text only says a reply is waiting: the reply itself stays in the app, where only the player can read it.
    await notify(db, { userId: t.user_id, kind: "SUPPORT_REPLY", link: "#/support", dedupeKey: `support:${ticketId}:${n}`,
      title: `Reply about "${t.subject}"`, body: "Support has replied to your request. Open it to read the reply.",
      sms: "Support has replied to your request. Open the app to read it.",
      ha: { title: `Amsa game da "${t.subject}"`, body: "Masu taimako sun amsa buƙatarka. Buɗe ta don karanta amsar.",
        sms: "Masu taimako sun amsa buƙatarka. Buɗe manhajar don karanta ta." } });
    await audit(db, adminActor(admin), "support.staff_replied", "support_ticket", ticketId, { closed: Boolean(input.close) });
    return { status };
  });
}

export async function closeTicket(ctx: Ctx, admin: Admin, ticketId: string): Promise<{ status: string }> {
  requireRole(admin, "SUPPORT", "COMPLIANCE");
  return withTx(ctx.pool, async (db) => {
    const r = await db.query("UPDATE support_tickets SET status = 'CLOSED', closed_at = now(), closed_by = $2, updated_at = now() WHERE id = $1 AND status <> 'CLOSED'", [ticketId, admin.id]);
    if (!r.rowCount) throw conflict("TICKET_CLOSED", "This request is already closed, or does not exist.");
    await audit(db, adminActor(admin), "support.ticket_closed", "support_ticket", ticketId);
    return { status: "CLOSED" };
  });
}

/** Passes a request to Compliance (suspected fraud, a complaint, anything support cannot decide). */
export async function escalate(ctx: Ctx, admin: Admin, ticketId: string, reason: string): Promise<{ escalated: true }> {
  requireRole(admin, "SUPPORT");
  const why = clean(reason, 500);
  return withTx(ctx.pool, async (db) => {
    const r = await db.query("UPDATE support_tickets SET escalated = true, updated_at = now() WHERE id = $1 AND NOT escalated", [ticketId]);
    if (!r.rowCount) throw conflict("ALREADY_ESCALATED", "This request has already been passed to Compliance, or does not exist.");
    await db.query("INSERT INTO compliance_alerts (kind, severity, entity_type, entity_id, details) VALUES ('SUPPORT_ESCALATION', 'WARNING', 'support_ticket', $1, $2)",
      [ticketId, JSON.stringify({ reason: why })]);
    await audit(db, adminActor(admin), "support.escalated", "support_ticket", ticketId, { reason: why });
    return { escalated: true };
  });
}

/**
 * What support sees about a player. Phone numbers are masked; identity and bank
 * numbers are never shown; ticket outcomes appear only once the player has
 * revealed them. Every look is written to the audit trail.
 */
export async function playerSummary(ctx: Ctx, admin: Admin, phone: string): Promise<unknown> {
  requireRole(admin, ...VIEW);
  const u = await one<{ id: string; full_name: string | null; kyc_tier: number; status: string; state_code: string | null; created_at: Date; phone_e164: string; pin_locked_until: Date | null }>(
    ctx.pool, "SELECT id, full_name, kyc_tier, status, state_code, created_at, phone_e164, pin_locked_until FROM users WHERE phone_e164 = $1", [normalisePhone(phone)]);
  if (!u) throw notFound("No player has that phone number.");
  const q = (sql: string) => ctx.pool.query(sql, [u.id]).then((r) => r.rows);
  const db = await ctx.pool.connect();
  try {
    const [limits, exclusion, lock, orders, cards, claims, payouts, banks, texts, tickets] = await Promise.all([
      q("SELECT daily_kobo, weekly_kobo, monthly_kobo, pending_effective_at FROM rg_limits WHERE user_id = $1"),
      q("SELECT kind, ends_at FROM self_exclusions WHERE user_id = $1 AND starts_at <= now() AND (ends_at IS NULL OR ends_at > now())"),
      q(`SELECT l.id, l.reason, l.locked_at, a.full_name AS locked_by_name FROM player_locks l JOIN admin_users a ON a.id = l.locked_by WHERE l.user_id = $1 AND l.lifted_at IS NULL`),
      q(`SELECT o.created_at, o.quantity, o.amount_kobo, o.status, c.name AS cycle FROM orders o JOIN cycles c ON c.id = o.cycle_id WHERE o.user_id = $1 ORDER BY o.created_at DESC LIMIT 20`),
      q(`SELECT count(*)::int AS total, count(*) FILTER (WHERE status = 'REVEALED')::int AS revealed, count(*) FILTER (WHERE status = 'CANCELLED')::int AS cancelled FROM tickets WHERE owner_id = $1`),
      q(`SELECT pt.title, pc.status, pc.expires_at, pc.claimed_by_next_of_kin FROM prize_claims pc JOIN prize_tiers pt ON pt.id = pc.prize_tier_id WHERE pc.user_id = $1 AND pt.kind = 'MERCHANDISE' ORDER BY pc.created_at DESC LIMIT 20`),
      q("SELECT amount_kobo, status, created_at FROM payouts WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20"),
      q("SELECT bank_code, name_match, usable_from FROM bank_accounts WHERE user_id = $1 AND status = 'ACTIVE'"),
      q("SELECT kind, body, status, created_at, sent_at FROM notifications WHERE user_id = $1 AND channel = 'SMS' ORDER BY created_at DESC LIMIT 20"),
      q("SELECT id, topic, subject, status, updated_at FROM support_tickets WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 20"),
    ]);
    const balance = await winningsBalance(db, u.id);
    await withTx(ctx.pool, (tx) => audit(tx, adminActor(admin), "support.player_viewed", "user", u.id));
    return {
      player: { id: u.id, name: u.full_name, phone: "…" + u.phone_e164.slice(-4), verified: u.kyc_tier >= 1, state: u.state_code, status: u.status, since: u.created_at,
        pinLocked: Boolean(u.pin_locked_until && u.pin_locked_until.getTime() > Date.now()) },
      lock: lock[0] ?? null, limits: limits[0] ?? null, exclusion: exclusion[0] ?? null,
      winningsKobo: Math.max(0, balance), owedKobo: Math.max(0, -balance),
      orders, cards: cards[0], claims, payouts, bankAccounts: banks, texts, tickets,
    };
  } finally {
    db.release();
  }
}

// --- Locking an account on a suspected takeover --------------------------------------------------------

export async function lockPlayer(ctx: Ctx, admin: Admin, userId: string, reason: string): Promise<{ locked: true }> {
  requireRole(admin, "SUPPORT", "COMPLIANCE");
  const why = clean(reason, 500);
  return withTx(ctx.pool, async (db) => {
    const u = await one<{ status: string }>(db, "SELECT status FROM users WHERE id = $1 FOR UPDATE", [userId]);
    if (!u) throw notFound("Player not found.");
    if (u.status !== "ACTIVE") throw conflict("NOT_ACTIVE", "This account is not active, so it cannot be locked.");
    await db.query("INSERT INTO player_locks (user_id, reason, locked_by) VALUES ($1, $2, $3)", [userId, why, admin.id]);
    await db.query("UPDATE users SET status = 'SUSPENDED' WHERE id = $1", [userId]);
    await db.query("UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL", [userId]); // signed out everywhere at once
    await notify(db, { userId, kind: "SECURITY", urgent: true, dedupeKey: `lock:${userId}:${Date.now()}`,
      title: "Your account has been locked", body: "We locked your account to protect it. Contact support to unlock it.",
      sms: "We have locked your account to protect it. Contact support to unlock it.",
      ha: { title: "An kulle asusunka", body: "Mun kulle asusunka don kare shi. Tuntuɓi masu taimako don buɗe shi.",
        sms: "Mun kulle asusunka don kare shi. Tuntuɓi masu taimako don buɗe shi." } });
    await audit(db, adminActor(admin), "support.player_locked", "user", userId, { reason: why });
    return { locked: true };
  });
}

export async function unlockPlayer(ctx: Ctx, admin: Admin, userId: string, reason: string): Promise<{ unlocked: true }> {
  requireRole(admin, "COMPLIANCE");
  const why = clean(reason, 500);
  return withTx(ctx.pool, async (db) => {
    const l = await one<{ id: string; locked_by: string }>(db, "SELECT id, locked_by FROM player_locks WHERE user_id = $1 AND lifted_at IS NULL FOR UPDATE", [userId]);
    if (!l) throw notFound("This account is not locked.");
    if (l.locked_by === admin.id) throw forbidden("SAME_PERSON", "You locked this account, so someone else in Compliance must unlock it.");
    await db.query("UPDATE player_locks SET lifted_by = $2, lifted_at = now(), lift_reason = $3 WHERE id = $1", [l.id, admin.id, why]);
    await db.query("UPDATE users SET status = 'ACTIVE' WHERE id = $1", [userId]);
    await audit(db, adminActor(admin), "support.player_unlocked", "user", userId, { reason: why });
    return { unlocked: true };
  });
}

