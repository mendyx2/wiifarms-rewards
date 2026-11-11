import { audit, type Actor } from "../audit.ts";
import type { Ctx } from "../context.ts";
import { lockKey, one, withTx, type Db } from "../db.ts";
import { badRequest, conflict, forbidden, notFound } from "../errors.ts";
import { accounts, balance, post } from "../ledger.ts";
import { adminActor, requireRole, type Admin } from "./admin.ts";
import { onExclusionRegister, type User } from "./identity.ts";

const MIN_PAYOUT_KOBO = 50_000; // ₦500

/** What the player can withdraw: the credit balance of their winnings account in the ledger. */
export async function winningsBalance(db: Db, userId: string): Promise<number> {
  return -(await balance(db, accounts.playerWinnings(userId).code));
}

export async function getWallet(ctx: Ctx, userId: string): Promise<unknown> {
  const db = await ctx.pool.connect();
  try {
    const history = await db.query(
      `SELECT t.kind, t.created_at, -e.amount_kobo AS amount_kobo
       FROM ledger_entries e JOIN ledger_transactions t ON t.id = e.transaction_id JOIN ledger_accounts a ON a.id = e.account_id
       WHERE a.code = $1 ORDER BY e.id DESC LIMIT 100`, [accounts.playerWinnings(userId).code]);
    const payouts = await db.query("SELECT id, amount_kobo, status, created_at FROM payouts WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50", [userId]);
    return { balanceKobo: await winningsBalance(db, userId), history: history.rows, payouts: payouts.rows };
  } finally {
    db.release();
  }
}

/** Sends the money (simulated) and closes the payout in the ledger. */
async function send(db: Db, payoutId: string, amountKobo: number): Promise<void> {
  await db.query("UPDATE payouts SET status = 'CONFIRMED', provider = 'SIMULATED', provider_ref = $2 WHERE id = $1", [payoutId, `SIMPO-${payoutId}`]);
  await post(db, { kind: "PAYOUT", reference: `payout:${payoutId}:sent`, debit: accounts.payoutsInTransit(), credit: accounts.gatewayClearing(), amountKobo });
}

/**
 * Player withdrawal. The PIN has already been re-confirmed by the caller.
 * Money only ever goes to a bank account in the player's own verified name
 * that has passed its cooling-off period. The amount is moved out of the
 * winnings balance immediately, so it cannot be withdrawn twice while an
 * approval is pending.
 */
export async function requestPayout(ctx: Ctx, actor: Actor, user: User, input: { amountKobo: number; bankAccountId: string; idempotencyKey: string }): Promise<{ id: string; status: string }> {
  if (!Number.isSafeInteger(input.amountKobo) || input.amountKobo < MIN_PAYOUT_KOBO) throw badRequest("INVALID_AMOUNT", "The minimum withdrawal is ₦500.");
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(input.idempotencyKey)) throw badRequest("INVALID_IDEMPOTENCY_KEY", "Missing or invalid Idempotency-Key.");
  return withTx(ctx.pool, async (db) => {
    await lockKey(db, `player:${user.id}`);
    const replay = await one<{ id: string; status: string; user_id: string }>(db, "SELECT id, status, user_id FROM payouts WHERE idempotency_key = $1", [`${user.id}:${input.idempotencyKey}`]);
    if (replay) return { id: replay.id, status: replay.status };

    const account = await one<{ id: string; name_match: boolean; usable_from: Date; status: string }>(
      db, "SELECT id, name_match, usable_from, status FROM bank_accounts WHERE id = $1 AND user_id = $2", [input.bankAccountId, user.id]);
    if (!account || account.status !== "ACTIVE") throw notFound("Bank account not found.");
    if (!account.name_match) throw forbidden("NAME_MISMATCH", "Winnings can only be paid to a bank account in your own verified name.");
    if (account.usable_from.getTime() > Date.now()) throw forbidden("BANK_COOLING_OFF", "This bank account was added recently. For your safety it can receive payouts after the waiting period.");
    if ((await winningsBalance(db, user.id)) < input.amountKobo) throw conflict("INSUFFICIENT_WINNINGS", "You do not have that much to withdraw.");

    // Staff-register match or an open fraud alert puts the payout on hold for a person to review.
    const flagged = (await onExclusionRegister(db, user)) ||
      Boolean(await one(db, "SELECT 1 FROM compliance_alerts WHERE entity_type = 'user' AND entity_id = $1 AND status = 'OPEN' AND severity = 'CRITICAL'", [user.id]));
    const requiresApproval = flagged || input.amountKobo >= ctx.config.payoutApprovalThresholdKobo;

    const r = await db.query<{ id: string }>(
      `INSERT INTO payouts (user_id, bank_account_id, amount_kobo, idempotency_key, status, requires_approval)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [user.id, account.id, input.amountKobo, `${user.id}:${input.idempotencyKey}`, requiresApproval ? "PENDING_APPROVAL" : "REQUESTED", requiresApproval]);
    const id = r.rows[0]!.id;
    await post(db, { kind: "PAYOUT", reference: `payout:${id}:requested`, debit: accounts.playerWinnings(user.id), credit: accounts.payoutsInTransit(), amountKobo: input.amountKobo });
    await audit(db, actor, "payout.requested", "payout", id, { amountKobo: input.amountKobo, requiresApproval, flagged });
    if (requiresApproval) return { id, status: "PENDING_APPROVAL" };
    await send(db, id, input.amountKobo);
    return { id, status: "CONFIRMED" };
  });
}

export async function listPendingPayouts(ctx: Ctx, admin: Admin): Promise<unknown[]> {
  requireRole(admin, "FINANCE", "PAYOUT_APPROVER", "COMPLIANCE", "AUDITOR");
  const r = await ctx.pool.query(
    `SELECT p.id, p.amount_kobo, p.status, p.created_at, right(u.phone_e164, 4) AS phone_last4, b.name_match
     FROM payouts p JOIN users u ON u.id = p.user_id JOIN bank_accounts b ON b.id = p.bank_account_id
     WHERE p.status = 'PENDING_APPROVAL' ORDER BY p.created_at`);
  return r.rows;
}

/** A second person releases or rejects a held payout. Rejection returns the money to the player's winnings. */
export async function decidePayout(ctx: Ctx, admin: Admin, payoutId: string, approve: boolean, reason?: string): Promise<{ status: string }> {
  requireRole(admin, "PAYOUT_APPROVER");
  return withTx(ctx.pool, async (db) => {
    const p = await one<{ id: string; user_id: string; amount_kobo: number; status: string }>(db, "SELECT id, user_id, amount_kobo, status FROM payouts WHERE id = $1 FOR NO KEY UPDATE", [payoutId]);
    if (!p) throw notFound("Payout not found.");
    if (p.status !== "PENDING_APPROVAL") throw conflict("ALREADY_DECIDED", "This payout has already been decided.");
    if (!approve) {
      if (!reason?.trim()) throw badRequest("REASON_REQUIRED", "Give a reason for rejecting the payout.");
      await db.query("UPDATE payouts SET status = 'REJECTED', approved_by = $2 WHERE id = $1", [p.id, admin.id]);
      await post(db, { kind: "PAYOUT_REVERSAL", reference: `payout:${p.id}:rejected`, debit: accounts.payoutsInTransit(), credit: accounts.playerWinnings(p.user_id), amountKobo: p.amount_kobo });
      await audit(db, adminActor(admin), "payout.rejected", "payout", p.id, { reason });
      return { status: "REJECTED" };
    }
    await db.query("UPDATE payouts SET status = 'APPROVED', approved_by = $2 WHERE id = $1", [p.id, admin.id]);
    await audit(db, adminActor(admin), "payout.approved", "payout", p.id, { amountKobo: p.amount_kobo });
    await send(db, p.id, p.amount_kobo);
    return { status: "CONFIRMED" };
  });
}
