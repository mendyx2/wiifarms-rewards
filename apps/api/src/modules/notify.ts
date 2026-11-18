import { SYSTEM, audit } from "../audit.ts";
import type { Ctx } from "../context.ts";
import { one, withTx, type Db } from "../db.ts";
import { requireRole, type Admin } from "./admin.ts";

/**
 * Notifications.
 *
 * notify() is always called inside the transaction of the event it reports, so
 * the message exists exactly when the event does. In-app messages are visible
 * at once; texts are queued and sent by deliverMessages(). The dedupe key makes
 * repeating an event (a retry, a re-run) harmless.
 *
 * Texts never contain a PIN, a one-time code or a handover code, and always
 * point people to the app rather than to a link.
 */

const LAGOS_OFFSET_MS = 60 * 60 * 1000; // Nigeria is UTC+1 all year
const DAY_START = 8, DAY_END = 20; // texts that can wait are sent between 08:00 and 20:00

/** When a text may be sent: now if urgent or during the day, otherwise 08:00 Nigerian time next. */
export function nextSendTime(now: Date, urgent: boolean): Date {
  if (urgent) return now;
  const local = new Date(now.getTime() + LAGOS_OFFSET_MS);
  const hour = local.getUTCHours();
  if (hour >= DAY_START && hour < DAY_END) return now;
  const target = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + (hour >= DAY_END ? 1 : 0), DAY_START));
  return new Date(target.getTime() - LAGOS_OFFSET_MS);
}

export interface Notice {
  userId: string;
  kind: string;
  title: string;
  body: string;
  /** App screen, e.g. "#/wallet". */
  link?: string;
  /** Text-message version. Omit for in-app only. */
  sms?: string;
  /** Security and money messages go at once; others respect daytime hours. */
  urgent?: boolean;
  dedupeKey: string;
}

const SMS_FOOTER = " - WiiFarm Rewards. We will never ask for your PIN.";

/**
 * Keeps texts in the standard SMS character set: one non-standard character
 * (such as ₦ in a prize name typed by staff) would switch the whole message to
 * a format that holds less than half as many characters, at higher cost.
 */
export function smsText(text: string): string {
  return text.replaceAll("₦", "N").replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, "-").replace(/…/g, "...");
}

export async function notify(db: Db, n: Notice): Promise<void> {
  await db.query(
    `INSERT INTO notifications (user_id, channel, kind, title, body, link, dedupe_key, status, sent_at)
     VALUES ($1, 'IN_APP', $2, $3, $4, $5, $6, 'SENT', now()) ON CONFLICT (dedupe_key, channel) DO NOTHING`,
    [n.userId, n.kind, n.title, n.body, n.link ?? null, n.dedupeKey]);
  if (n.sms) {
    await db.query(
      `INSERT INTO notifications (user_id, channel, kind, title, body, link, dedupe_key, status, not_before)
       VALUES ($1, 'SMS', $2, $3, $4, $5, $6, 'QUEUED', $7) ON CONFLICT (dedupe_key, channel) DO NOTHING`,
      [n.userId, n.kind, n.title, smsText(n.sms + SMS_FOOTER), n.link ?? null, n.dedupeKey, nextSendTime(new Date(), Boolean(n.urgent))]);
  }
}

export const naira = (kobo: number): string => "N" + (kobo / 100).toLocaleString("en-NG", { maximumFractionDigits: 2 });

// --- Delivery ---------------------------------------------------------------------------------

const MAX_ATTEMPTS = 5;

/**
 * Sends due texts. Each message is claimed with a row lock so two workers never
 * send the same one; a failed send is retried with growing delays (1, 2, 4, 8
 * minutes) and marked FAILED after five attempts, for Support to follow up.
 */
export async function deliverMessages(ctx: Ctx, batch = 50): Promise<{ sent: number; failed: number }> {
  let sent = 0, failed = 0;
  for (let i = 0; i < batch; i++) {
    const done = await withTx(ctx.pool, async (db) => {
      const m = await one<{ id: string; body: string; phone_e164: string; attempts: number }>(db,
        `SELECT n.id, n.body, u.phone_e164, n.attempts FROM notifications n JOIN users u ON u.id = n.user_id
         WHERE n.channel = 'SMS' AND n.status = 'QUEUED' AND n.not_before <= now()
         ORDER BY n.not_before, n.created_at LIMIT 1 FOR UPDATE OF n SKIP LOCKED`);
      if (!m) return null;
      try {
        const r = await ctx.messenger.send(m.phone_e164, m.body);
        await db.query("UPDATE notifications SET status = 'SENT', sent_at = now(), attempts = attempts + 1, provider_ref = $2, last_error = NULL WHERE id = $1", [m.id, r.providerRef]);
        return "sent";
      } catch (err) {
        const attempts = m.attempts + 1;
        await db.query(
          `UPDATE notifications SET attempts = $2::int, last_error = $3, status = CASE WHEN $2::int >= $4::int THEN 'FAILED' ELSE 'QUEUED' END,
             not_before = now() + make_interval(mins => power(2, $2::int - 1)::int) WHERE id = $1`,
          [m.id, attempts, String((err as Error).message).slice(0, 300), MAX_ATTEMPTS]);
        return attempts >= MAX_ATTEMPTS ? "failed" : "retry";
      }
    });
    if (done === null) break;
    if (done === "sent") sent++;
    if (done === "failed") failed++;
  }
  return { sent, failed };
}

// --- Unclaimed-prize reminders ------------------------------------------------------------------

const REMINDER_DAYS = [7, 30, 60, 80];

/**
 * Reminds winners who have not yet claimed a merchandise prize, 7, 30, 60 and
 * 80 days after the win. If several are due at once (for example after an
 * outage), only the latest is sent. Run hourly.
 */
export async function sendClaimReminders(ctx: Ctx): Promise<number> {
  return withTx(ctx.pool, async (db) => {
    const claims = await db.query<{ id: string; user_id: string; title: string; cycle: string; age_days: number; expires_at: Date }>(
      `SELECT pc.id, pc.user_id, pt.title, c.name AS cycle, floor(extract(epoch FROM now() - pc.created_at) / 86400)::int AS age_days, pc.expires_at
       FROM prize_claims pc JOIN prize_tiers pt ON pt.id = pc.prize_tier_id JOIN cycles c ON c.id = pt.cycle_id
       WHERE pc.status = 'ENTITLED' AND pt.kind = 'MERCHANDISE' AND pc.expires_at > now()`);
    let n = 0;
    for (const c of claims.rows) {
      const due = REMINDER_DAYS.filter((d) => c.age_days >= d).pop();
      if (!due) continue;
      const left = Math.max(0, Math.ceil((c.expires_at.getTime() - Date.now()) / 86400_000));
      const r = await db.query("SELECT 1 FROM notifications WHERE dedupe_key = $1", [`claim:${c.id}:reminder:${due}`]);
      if (r.rowCount) continue;
      await notify(db, {
        userId: c.user_id, kind: "CLAIM_REMINDER", link: "#/wallet", dedupeKey: `claim:${c.id}:reminder:${due}`,
        title: `Your ${c.title} is waiting`,
        body: `You won ${c.title} in ${c.cycle}. Claim it within ${left} day${left === 1 ? "" : "s"}, or it will no longer be available.`,
        sms: `You won ${c.title} in ${c.cycle}. Claim it in the app within ${left} days.`,
      });
      n++;
    }
    if (n) await audit(db, SYSTEM, "notify.claim_reminders", "prize_claim", "batch", { sent: n });
    return n;
  });
}

// --- Reading -------------------------------------------------------------------------------------

export async function inbox(ctx: Ctx, userId: string): Promise<{ unread: number; items: unknown[] }> {
  const items = (await ctx.pool.query(
    `SELECT id, kind, title, body, link, created_at, read_at FROM notifications WHERE user_id = $1 AND channel = 'IN_APP' ORDER BY created_at DESC LIMIT 50`, [userId])).rows;
  const unread = (await one<{ n: number }>(ctx.pool, "SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND channel = 'IN_APP' AND read_at IS NULL", [userId]))!.n;
  return { unread, items };
}

/** Marks the player's own in-app messages as read (all of them, or the ones given). */
export async function markRead(ctx: Ctx, userId: string, ids?: string[]): Promise<{ unread: number }> {
  await ctx.pool.query(
    `UPDATE notifications SET read_at = now() WHERE user_id = $1 AND channel = 'IN_APP' AND read_at IS NULL AND ($2::uuid[] IS NULL OR id = ANY($2::uuid[]))`,
    [userId, ids ?? null]);
  return { unread: (await inbox(ctx, userId)).unread };
}

/** Text messages, for Support and Compliance to answer "did they get the message?". */
export async function messageLog(ctx: Ctx, admin: Admin): Promise<unknown> {
  requireRole(admin, "SUPPORT", "COMPLIANCE", "AUDITOR");
  const rows = (await ctx.pool.query(
    `SELECT n.id, n.kind, n.body, n.status, n.attempts, n.last_error, n.created_at, n.not_before, n.sent_at, '…' || right(u.phone_e164, 4) AS phone
     FROM notifications n JOIN users u ON u.id = n.user_id WHERE n.channel = 'SMS' ORDER BY n.created_at DESC LIMIT 200`)).rows;
  const counts = (await one<{ queued: number; failed: number; sent_today: number }>(ctx.pool,
    `SELECT count(*) FILTER (WHERE status = 'QUEUED')::int AS queued, count(*) FILTER (WHERE status = 'FAILED')::int AS failed,
            count(*) FILTER (WHERE status = 'SENT' AND (sent_at AT TIME ZONE 'Africa/Lagos')::date = (now() AT TIME ZONE 'Africa/Lagos')::date)::int AS sent_today
     FROM notifications WHERE channel = 'SMS'`))!;
  return { ...counts, messages: rows };
}
