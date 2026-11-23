import { randomBytes } from "node:crypto";
import type { Ctx } from "../context.ts";
import { one, type Db } from "../db.ts";
import { badRequest } from "../errors.ts";
import { accounts, post } from "../ledger.ts";
import { POLICY, share } from "../policy.ts";
import { audit, SYSTEM } from "../audit.ts";
import { onExclusionRegister, type User } from "./identity.ts";

/**
 * Referrals. Every player has a code; whoever's code was used when an account
 * was opened earns a commission on each card purchase that account makes,
 * paid into their wallet from the operator's share of the sale (never from the
 * prize money). There is no separate affiliate sign-up and only one level: a
 * referrer earns from the people they invited, not from people those invited.
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
 * Pays the commission on a completed purchase, in the purchase's transaction.
 * Nothing is paid to closed accounts or to people on the staff and exclusion
 * register (who must not profit from play).
 */
export async function creditReferral(ctx: Ctx, db: Db, order: { id: string; user_id: string; cycle_id: string; quantity: number; amount_kobo: number }): Promise<void> {
  const ref = await one<User & { referred_by: string | null }>(db,
    `SELECT r.id, r.phone_e164, r.full_name, r.date_of_birth::text, r.kyc_tier, r.identity_hash, r.state_code, r.status, r.language
     FROM users b JOIN users r ON r.id = b.referred_by WHERE b.id = $1`, [order.user_id]);
  if (!ref || ref.status === "CLOSED" || (await onExclusionRegister(db, ref))) return;
  const rateBp = (ctx.config.policy ?? POLICY).referralBp;
  const amount = share(Number(order.amount_kobo), rateBp);
  if (amount <= 0) return;
  const row = await db.query(
    `INSERT INTO referral_commissions (order_id, referrer_id, buyer_id, cycle_id, cards, rate_bp, amount_kobo)
     VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (order_id) DO NOTHING`,
    [order.id, ref.id, order.user_id, order.cycle_id, order.quantity, rateBp, amount]);
  if (!row.rowCount) return;
  await post(db, { kind: "REFERRAL_COMMISSION", reference: `order:${order.id}:referral`, cycleId: order.cycle_id,
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
 * What a player sees about their referrals. Never who the referred people are:
 * only counts and amounts.
 */
export async function referralSummary(ctx: Ctx, userId: string): Promise<unknown> {
  const db = await ctx.pool.connect();
  try {
    const code = await ensureReferralCode(db, userId);
    const s = (await one<{ joined: number; buyers: number; cards: number; earned: number; reversed: number }>(db,
      `SELECT (SELECT count(*) FROM users WHERE referred_by = $1)::int AS joined,
              (SELECT count(DISTINCT buyer_id) FROM referral_commissions WHERE referrer_id = $1 AND status = 'EARNED')::int AS buyers,
              (SELECT coalesce(sum(cards), 0) FROM referral_commissions WHERE referrer_id = $1 AND status = 'EARNED')::int AS cards,
              (SELECT coalesce(sum(amount_kobo), 0) FROM referral_commissions WHERE referrer_id = $1 AND status = 'EARNED')::bigint AS earned,
              (SELECT coalesce(sum(amount_kobo), 0) FROM referral_commissions WHERE referrer_id = $1 AND status = 'REVERSED')::bigint AS reversed`, [userId]))!;
    const recent = (await db.query(
      "SELECT cards, amount_kobo, status, created_at FROM referral_commissions WHERE referrer_id = $1 ORDER BY created_at DESC LIMIT 30", [userId])).rows;
    const policy = ctx.config.policy ?? POLICY;
    return { code, link: `/r/${code}`, ratePercent: policy.referralBp / 100, friendsJoined: s.joined, friendsWhoBought: s.buyers,
      cardsBought: s.cards, earnedKobo: Number(s.earned), reversedKobo: Number(s.reversed), recent };
  } finally {
    db.release();
  }
}
