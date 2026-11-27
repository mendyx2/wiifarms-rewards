import { randomBytes } from "node:crypto";
import type { Ctx } from "../context.ts";
import { one, type Db } from "../db.ts";
import { badRequest } from "../errors.ts";
import { accounts, post } from "../ledger.ts";
import { POLICY, share } from "../policy.ts";
import { audit, SYSTEM } from "../audit.ts";
import { onExclusionRegister, type User } from "./identity.ts";

/**
 * Referrals: the simple model the board chose in place of separate affiliates.
 * Every player has a link. Whoever's link was used when an account was opened
 * earns 10% (₦50 a card) of every card purchase that account makes, paid into
 * their wallet with their winnings, from the operator's share of the sale
 * (never the prize money). One level only: nothing is earned on friends of
 * friends, or on one's own cards. Earnings are taken back if the purchase is
 * refunded. No application or approval is needed; a player whose promotion
 * breaks the rules can have their earnings stopped after an investigation
 * (portal.ts).
 */

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O or 1/I look-alikes
const CODE = /^[A-HJ-NP-Z2-9]{7}$/;

function newCode(): string {
  const b = randomBytes(7);
  let s = "";
  for (let i = 0; i < 7; i++) s += ALPHABET[b[i]! & 31];
  return s;
}

/** The player's referral code, issued the first time it is needed. */
export async function ensureReferralCode(db: Db, userId: string): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const existing = await one<{ referral_code: string | null }>(db, "SELECT referral_code FROM users WHERE id = $1", [userId]);
    if (existing?.referral_code) return existing.referral_code;
    const r = await db.query("UPDATE users SET referral_code = $2 WHERE id = $1 AND referral_code IS NULL AND NOT EXISTS (SELECT 1 FROM users WHERE referral_code = $2)", [userId, newCode()]);
    if (r.rowCount) continue; // read it back on the next pass
  }
  throw new Error("could not issue a referral code");
}

/** Codes are typed by people: case and spaces do not matter. */
export const normaliseCode = (code: string): string => code.toUpperCase().replace(/[\s-]/g, "");

/**
 * The account an invite code belongs to, for a new sign-up. Links of former
 * affiliates (8 characters) still work: they now count for the affiliate's own
 * player account.
 */
export async function findReferrer(db: Db, code: string): Promise<string> {
  const c = normaliseCode(code);
  const r = CODE.test(c) ? await one<{ id: string }>(db, "SELECT id FROM users WHERE referral_code = $1 AND status = 'ACTIVE'", [c])
    : /^[A-HJ-NP-Z2-9]{8}$/.test(c) ? await one<{ id: string }>(db, "SELECT u.id FROM affiliates a JOIN users u ON u.id = a.user_id WHERE a.attribution_code = $1 AND u.status = 'ACTIVE'", [c])
    : null;
  if (!r) throw badRequest("INVALID_REFERRAL", "That invite code is not recognised. Check it, or leave it empty.");
  return r.id;
}

/**
 * Pays the referral earnings on a completed purchase, in the purchase's
 * transaction. Nothing is paid to closed accounts, to people on the staff and
 * exclusion register (who must not profit from play), or to a player whose
 * earnings were stopped after an investigation.
 */
export async function creditReferral(ctx: Ctx, db: Db, order: { id: string; user_id: string; cycle_id: string; quantity: number; amount_kobo: number }): Promise<void> {
  const ref = await one<User & { referral_earnings_blocked: boolean }>(db,
    `SELECT r.id, r.phone_e164, r.full_name, r.date_of_birth::text, r.kyc_tier, r.identity_hash, r.state_code, r.status, r.language, r.referral_earnings_blocked
     FROM users b JOIN users r ON r.id = b.referred_by WHERE b.id = $1`, [order.user_id]);
  if (!ref || ref.id === order.user_id || ref.status === "CLOSED" || ref.referral_earnings_blocked || (await onExclusionRegister(db, ref))) return;
  const rateBp = (ctx.config.policy ?? POLICY).referralBp;
  const amount = share(Number(order.amount_kobo), rateBp);
  if (amount <= 0) return;
  const row = await db.query(
    `INSERT INTO referral_commissions (order_id, referrer_id, buyer_id, cycle_id, cards, rate_bp, amount_kobo)
     VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (order_id) DO NOTHING`,
    [order.id, ref.id, order.user_id, order.cycle_id, order.quantity, rateBp, amount]);
  if (!row.rowCount) return;
  await post(db, { kind: "REFERRAL_COMMISSION", reference: `order:${order.id}:referral`, cycleId: order.cycle_id, memo: `${order.quantity} card${order.quantity === 1 ? "" : "s"} bought by a friend`,
    debit: accounts.referralExpense(order.cycle_id), credit: accounts.playerWinnings(ref.id), amountKobo: amount });
}

/**
 * Takes back the commission on a purchase that has been refunded. If the
 * referrer has already withdrawn it, their wallet goes below zero (owed) and
 * Compliance is told.
 */
export async function reverseReferral(db: Db, orderId: string): Promise<void> {
  const c = await one<{ id: string; referrer_id: string; cycle_id: string; amount_kobo: number }>(db,
    "UPDATE referral_commissions SET status = 'REVERSED', reversed_at = now() WHERE order_id = $1 AND status = 'EARNED' RETURNING id, referrer_id, cycle_id, amount_kobo", [orderId]);
  if (!c) return;
  await post(db, { kind: "REFERRAL_REVERSAL", reference: `order:${orderId}:referral:reversed`, cycleId: c.cycle_id, memo: "Referred purchase refunded",
    debit: accounts.playerWinnings(c.referrer_id), credit: accounts.referralExpense(c.cycle_id), amountKobo: Number(c.amount_kobo) });
  await audit(db, SYSTEM, "referral.reversed", "order", orderId, { referrerId: c.referrer_id, amountKobo: c.amount_kobo });
  const bal = await one<{ b: number }>(db,
    `SELECT -coalesce(sum(e.amount_kobo), 0)::bigint AS b FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id WHERE a.code = $1`,
    [accounts.playerWinnings(c.referrer_id).code]);
  if (bal!.b < 0) {
    await db.query("INSERT INTO compliance_alerts (kind, severity, entity_type, entity_id, details) VALUES ('REFERRAL_RECOVERY_REQUIRED', 'WARNING', 'user', $1, $2)",
      [c.referrer_id, JSON.stringify({ owedKobo: -bal!.b, orderId })]);
  }
}

/**
 * What a player sees about their referrals: their code and link, what they
 * have earned, recent earnings, and the approved messages to share. Never who
 * the referred people are: only counts and amounts.
 */
export async function referralSummary(ctx: Ctx, userId: string): Promise<unknown> {
  const db = await ctx.pool.connect();
  try {
    const code = await ensureReferralCode(db, userId);
    const s = (await one<{ joined: number; buyers: number; cards: number; earned: number; reversed: number; blocked: boolean }>(db,
      `SELECT (SELECT count(*) FROM users WHERE referred_by = $1)::int AS joined,
              (SELECT count(DISTINCT buyer_id) FROM referral_commissions WHERE referrer_id = $1 AND status = 'EARNED')::int AS buyers,
              (SELECT coalesce(sum(cards), 0) FROM referral_commissions WHERE referrer_id = $1 AND status = 'EARNED')::int AS cards,
              (SELECT coalesce(sum(amount_kobo), 0) FROM referral_commissions WHERE referrer_id = $1 AND status = 'EARNED')::bigint AS earned,
              (SELECT coalesce(sum(amount_kobo), 0) FROM referral_commissions WHERE referrer_id = $1 AND status = 'REVERSED')::bigint AS reversed,
              (SELECT referral_earnings_blocked FROM users WHERE id = $1) AS blocked`, [userId]))!;
    const recent = (await db.query(
      "SELECT cards, amount_kobo, status, created_at FROM referral_commissions WHERE referrer_id = $1 ORDER BY created_at DESC LIMIT 30", [userId])).rows
      .map((r) => ({ ...r, amount_kobo: Number(r.amount_kobo) }));
    const materials = (await db.query(
      `SELECT m.name, m.channel, v.id AS version_id, v.body_en, v.body_ha, v.image IS NOT NULL AS has_image
       FROM marketing_materials m JOIN marketing_material_versions v ON v.material_id = m.id AND v.status = 'APPROVED' ORDER BY m.channel, m.name`)).rows;
    const policy = ctx.config.policy ?? POLICY;
    return { code, link: `/r/${code}`, ratePercent: policy.referralBp / 100, friendsJoined: s.joined, friendsWhoPlayed: s.buyers, friendsWhoBought: s.buyers,
      cardsBought: s.cards, earnedKobo: Number(s.earned), reversedKobo: Number(s.reversed), earningsStopped: s.blocked, recent, materials };
  } finally {
    db.release();
  }
}

/** Staff view (Compliance, Finance, Auditor): the players whose links bring in the most buyers. Shown by code, not name. */
export async function listReferrers(ctx: Ctx, admin: import("./admin.ts").Admin): Promise<unknown> {
  const { requireRole } = await import("./admin.ts");
  requireRole(admin, "COMPLIANCE", "FINANCE", "AUDITOR");
  const rows = (await ctx.pool.query(
    `SELECT u.referral_code AS code, u.referral_earnings_blocked AS earnings_stopped, u.state_code,
            (SELECT count(*) FROM users x WHERE x.referred_by = u.id)::int AS friends,
            (SELECT count(*) FROM users x WHERE x.referred_by = u.id AND x.created_at > now() - interval '24 hours')::int AS friends_today,
            coalesce(sum(r.cards) FILTER (WHERE r.status = 'EARNED'), 0)::int AS cards,
            coalesce(sum(r.amount_kobo) FILTER (WHERE r.status = 'EARNED'), 0)::bigint AS earned_kobo,
            coalesce(sum(r.amount_kobo) FILTER (WHERE r.status = 'REVERSED'), 0)::bigint AS reversed_kobo
     FROM users u JOIN referral_commissions r ON r.referrer_id = u.id GROUP BY u.id ORDER BY earned_kobo DESC LIMIT 200`)).rows
    .map((r) => ({ ...r, earned_kobo: Number(r.earned_kobo), reversed_kobo: Number(r.reversed_kobo) }));
  const t = (await one<{ earned: string; players: number }>(ctx.pool,
    "SELECT coalesce(sum(amount_kobo) FILTER (WHERE status = 'EARNED'), 0)::bigint AS earned, count(DISTINCT referrer_id)::int AS players FROM referral_commissions"))!;
  return { ratePercent: (ctx.config.policy ?? POLICY).referralBp / 100, totalEarnedKobo: Number(t.earned), earningPlayers: t.players, referrers: rows };
}
