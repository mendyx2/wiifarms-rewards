import { audit, type Actor } from "../audit.ts";
import { naira, notify } from "./notify.ts";
import type { Ctx } from "../context.ts";
import { lockKey, one, withTx, type Db } from "../db.ts";
import { badRequest, conflict, forbidden, notFound } from "../errors.ts";
import { accounts, balance, post } from "../ledger.ts";
import { adminActor, requireRole, type Admin } from "./admin.ts";
import { DEFAULT_MAJOR_PRIZE_KOBO, livenessRequired, onExclusionRegister, type User } from "./identity.ts";

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
    // If a refunded purchase's prize had already been withdrawn, the player owes it back.
    const b = await winningsBalance(db, userId);
    return { balanceKobo: Math.max(0, b), owedKobo: Math.max(0, -b), history: history.rows, payouts: payouts.rows };
  } finally {
    db.release();
  }
}

/**
 * The player's own picture of their play (SRS section 7): what they have spent,
 * what they have won in cash, the difference, and their cards and Mega Draw
 * entries. Refunded purchases are not counted as spent; forfeited prizes are
 * not counted as won.
 */
export async function playSummary(ctx: Ctx, userId: string): Promise<unknown> {
  const s = (await one<{ spent: number; won: number; cards: number; entries: number; instant_wins: number }>(ctx.pool,
    `SELECT (SELECT coalesce(sum(amount_kobo), 0) FROM orders WHERE user_id = $1 AND status = 'FULFILLED')::bigint AS spent,
            (SELECT -coalesce(sum(e.amount_kobo), 0) FROM ledger_entries e JOIN ledger_transactions t ON t.id = e.transaction_id JOIN ledger_accounts a ON a.id = e.account_id
              WHERE a.code = $2 AND (t.kind IN ('INSTANT_PRIZE','DRAW_PRIZE') OR (t.kind = 'ADJUSTMENT' AND t.memo LIKE 'Prize forfeited%')))::bigint AS won,
            (SELECT count(*) FROM tickets WHERE owner_id = $1 AND status <> 'CANCELLED')::int AS cards,
            (SELECT count(*) FROM tickets t JOIN cycles c ON c.id = t.cycle_id WHERE t.owner_id = $1 AND t.status <> 'CANCELLED' AND c.status IN ('OPEN','CLOSED'))::int AS entries,
            (SELECT count(*) FROM tickets WHERE owner_id = $1 AND status = 'REVEALED' AND revealed_outcome LIKE 'CASH:%')::int AS instant_wins`,
    [userId, accounts.playerWinnings(userId).code]))!;
  return { spentKobo: Number(s.spent), cashWonKobo: Number(s.won), netKobo: Number(s.won) - Number(s.spent), cards: s.cards, finalDrawEntries: s.entries, instantWins: s.instant_wins };
}

/** Sends the money (simulated) and closes the payout in the ledger. */
async function send(db: Db, payoutId: string, amountKobo: number): Promise<void> {
  const p = await db.query<{ user_id: string }>("UPDATE payouts SET status = 'CONFIRMED', provider = 'SIMULATED', provider_ref = $2 WHERE id = $1 RETURNING user_id", [payoutId, `SIMPO-${payoutId}`]);
  await notify(db, { userId: p.rows[0]!.user_id, kind: "PAYOUT_SENT", urgent: true, link: "#/wallet", dedupeKey: `payout:${payoutId}:sent`,
    title: `${naira(amountKobo)} sent to your bank`, body: `Your withdrawal of ${naira(amountKobo)} has been sent to your bank account.`,
    sms: `Your withdrawal of ${naira(amountKobo)} has been sent to your bank account.`,
    ha: { title: `An tura ${naira(amountKobo)} zuwa bankinka`, body: `An tura kuɗin da ka cire, ${naira(amountKobo)}, zuwa asusun bankinka.`,
      sms: `An tura kuɗin da ka cire, ${naira(amountKobo)}, zuwa asusun bankinka.` } });
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
    // Large withdrawals need the liveness check, like major prizes.
    if (user.kyc_tier < 2 && input.amountKobo >= (ctx.config.majorPrizeKobo ?? DEFAULT_MAJOR_PRIZE_KOBO)) throw livenessRequired();

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
    if (requiresApproval) {
      await notify(db, { userId: user.id, kind: "PAYOUT_PENDING", link: "#/wallet", dedupeKey: `payout:${id}:pending`,
        title: "Withdrawal being checked", body: `Your withdrawal of ${naira(input.amountKobo)} is being checked by a second person, as we do for larger amounts. We will tell you when it is sent.`,
        ha: { title: "Ana duba buƙatar cirewa", body: `Wani mutum na biyu yana duba cirewarka ta ${naira(input.amountKobo)}, kamar yadda muke yi wa manyan kuɗi. Za mu sanar da kai idan an tura.` } });
    }
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
      await notify(db, { userId: p.user_id, kind: "PAYOUT_REJECTED", urgent: true, link: "#/wallet", dedupeKey: `payout:${p.id}:rejected`,
        title: "Withdrawal not sent", body: `Your withdrawal of ${naira(p.amount_kobo)} was not sent and the money is back in your winnings. Please contact support for the reason.`,
        sms: `Your withdrawal of ${naira(p.amount_kobo)} was not sent; the money is back in your winnings. Contact support for details.`,
        ha: { title: "Ba a tura kuɗin da ka cire ba", body: `Ba a tura cirewarka ta ${naira(p.amount_kobo)} ba kuma kuɗin sun dawo cikin kuɗin nasararka. Da fatan a tuntuɓi masu taimako don sanin dalili.`,
          sms: `Ba a tura cirewarka ta ${naira(p.amount_kobo)} ba; kuɗin sun dawo cikin kuɗin nasararka. Tuntuɓi masu taimako don bayani.` } });
      return { status: "REJECTED" };
    }
    await db.query("UPDATE payouts SET status = 'APPROVED', approved_by = $2 WHERE id = $1", [p.id, admin.id]);
    await audit(db, adminActor(admin), "payout.approved", "payout", p.id, { amountKobo: p.amount_kobo });
    await send(db, p.id, p.amount_kobo);
    return { status: "CONFIRMED" };
  });
}
