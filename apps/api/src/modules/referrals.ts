import { randomBytes } from "node:crypto";
import type { Ctx } from "../context.ts";
import { one, type Db } from "../db.ts";
import { badRequest } from "../errors.ts";
import { accounts, post } from "../ledger.ts";
import { audit, SYSTEM } from "../audit.ts";

/**
 * Player invite codes. Every player has one to share; whoever's code was used
 * when an account was opened is recorded as having invited it. Since the
 * board adopted the SRS affiliate model, inviting friends earns nothing:
 * marketing fees are for authorised affiliates only (affiliates.ts).
 * Commissions paid under the earlier model stay in the records, and are still
 * taken back if the purchase they came from is refunded.
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

/** The account an invite code belongs to, for a new sign-up. */
export async function findReferrer(db: Db, code: string): Promise<string> {
  const c = normaliseCode(code);
  const r = CODE.test(c) ? await one<{ id: string }>(db, "SELECT id FROM users WHERE referral_code = $1 AND status = 'ACTIVE'", [c]) : null;
  if (!r) throw badRequest("INVALID_REFERRAL", "That invite code is not recognised. Check it, or leave it empty.");
  return r.id;
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

/** What a player sees about their invites. Never who the invited people are: only counts. */
export async function referralSummary(ctx: Ctx, userId: string): Promise<unknown> {
  const db = await ctx.pool.connect();
  try {
    const code = await ensureReferralCode(db, userId);
    const s = (await one<{ joined: number; buyers: number }>(db,
      `SELECT (SELECT count(*) FROM users WHERE referred_by = $1)::int AS joined,
              (SELECT count(DISTINCT u.id) FROM users u WHERE u.referred_by = $1 AND EXISTS (SELECT 1 FROM orders o WHERE o.user_id = u.id AND o.status = 'FULFILLED'))::int AS buyers`, [userId]))!;
    const affiliate = await one<{ status: string }>(db, "SELECT status FROM affiliates WHERE user_id = $1", [userId]);
    return { code, link: `/r/${code}`, friendsJoined: s.joined, friendsWhoPlayed: s.buyers, affiliateStatus: affiliate?.status ?? null };
  } finally {
    db.release();
  }
}
