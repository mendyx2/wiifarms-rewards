import type { Ctx } from "../context.ts";
import { one, type Db } from "../db.ts";
import { accounts, post } from "../ledger.ts";
import { share } from "../policy.ts";
import { requireRole, type Admin } from "./admin.ts";

/**
 * Statutory deductions on cash prizes (SRS PAY-009). The rate is fixed on the
 * cycle when it is created and published with its rules. Each cash award
 * records its gross amount, the deduction and the net paid into the winner's
 * wallet; the deduction is held as a liability until remitted to the
 * authority. A rate of 0 still records every award (with a deduction of 0), so
 * the reports are complete whatever the rate turns out to be.
 */

export interface CashAward {
  ticketId: string; stage: "INSTANT" | "FINAL_DRAW"; userId: string; cycleId: string; grossKobo: number;
}

/** Credits a cash prize net of the deduction, in the caller's transaction. Returns what reached the wallet. */
export async function payCashPrize(db: Db, a: CashAward): Promise<{ netKobo: number; deductionKobo: number; rateBp: number }> {
  const c = await one<{ winnings_tax_bp: number }>(db, "SELECT winnings_tax_bp FROM cycles WHERE id = $1", [a.cycleId]);
  const rateBp = c!.winnings_tax_bp;
  const deductionKobo = share(a.grossKobo, rateBp);
  const netKobo = a.grossKobo - deductionKobo;
  const ref = `ticket:${a.ticketId}:${a.stage === "INSTANT" ? "instant" : "draw"}`;
  await db.query(
    `INSERT INTO prize_deductions (ticket_id, stage, user_id, cycle_id, gross_kobo, rate_bp, deduction_kobo, net_kobo)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, [a.ticketId, a.stage, a.userId, a.cycleId, a.grossKobo, rateBp, deductionKobo, netKobo]);
  await post(db, { kind: a.stage === "INSTANT" ? "INSTANT_PRIZE" : "DRAW_PRIZE", reference: ref, cycleId: a.cycleId,
    debit: accounts.prizeExpense(a.cycleId), credit: accounts.playerWinnings(a.userId), amountKobo: netKobo });
  if (deductionKobo > 0) {
    await post(db, { kind: "TAX", reference: `${ref}:deduction`, cycleId: a.cycleId, memo: `Statutory deduction at ${rateBp / 100}%`,
      debit: accounts.prizeExpense(a.cycleId), credit: accounts.deductionsPayable(), amountKobo: deductionKobo });
  }
  return { netKobo, deductionKobo, rateBp };
}

/**
 * Takes a forfeited cash prize back: the net from the winner's wallet and the
 * deduction from the amount held for the authority. Returns the gross.
 */
export async function forfeitCashPrize(db: Db, ticketId: string, stage: "INSTANT" | "FINAL_DRAW", memo: string): Promise<number> {
  const d = await one<{ user_id: string; cycle_id: string; gross_kobo: number; deduction_kobo: number; net_kobo: number }>(db,
    "UPDATE prize_deductions SET status = 'REVERSED', reversed_at = now() WHERE ticket_id = $1 AND stage = $2 AND status = 'DEDUCTED' RETURNING user_id, cycle_id, gross_kobo, deduction_kobo, net_kobo",
    [ticketId, stage]);
  if (!d) return 0;
  const ref = `ticket:${ticketId}:${stage === "INSTANT" ? "instant" : "draw"}`;
  await post(db, { kind: "ADJUSTMENT", reference: `${ref}:forfeit`, cycleId: d.cycle_id, memo,
    debit: accounts.playerWinnings(d.user_id), credit: accounts.prizeExpense(d.cycle_id), amountKobo: Number(d.net_kobo) });
  if (Number(d.deduction_kobo) > 0) {
    await post(db, { kind: "TAX_REVERSAL", reference: `${ref}:deduction:forfeit`, cycleId: d.cycle_id, memo,
      debit: accounts.deductionsPayable(), credit: accounts.prizeExpense(d.cycle_id), amountKobo: Number(d.deduction_kobo) });
  }
  return Number(d.gross_kobo);
}

/** The statutory deductions report: per day and per cycle, with the amount held for the authority. */
export async function deductionsReport(ctx: Ctx, admin: Admin, from: string, to: string): Promise<unknown> {
  requireRole(admin, "FINANCE", "COMPLIANCE", "AUDITOR");
  const days = (await ctx.pool.query(
    `SELECT (d.created_at AT TIME ZONE 'Africa/Lagos')::date::text AS day, c.name AS cycle, d.rate_bp,
            count(*)::int AS awards, sum(d.gross_kobo)::bigint AS gross_kobo, sum(d.deduction_kobo)::bigint AS deduction_kobo, sum(d.net_kobo)::bigint AS net_kobo
     FROM prize_deductions d JOIN cycles c ON c.id = d.cycle_id
     WHERE d.status = 'DEDUCTED' AND (d.created_at AT TIME ZONE 'Africa/Lagos')::date BETWEEN $1::date AND $2::date
     GROUP BY 1, 2, 3 ORDER BY 1, 2`, [from, to])).rows.map((r) => ({ ...r, gross_kobo: Number(r.gross_kobo), deduction_kobo: Number(r.deduction_kobo), net_kobo: Number(r.net_kobo) }));
  const held = await one<{ b: number }>(ctx.pool,
    "SELECT -coalesce(sum(e.amount_kobo), 0)::bigint AS b FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id WHERE a.code = $1", [accounts.deductionsPayable().code]);
  const zeroRate = await one<{ n: number }>(ctx.pool, "SELECT count(*)::int AS n FROM cycles WHERE winnings_tax_bp = 0 AND status NOT IN ('VOID','ARCHIVED')");
  return {
    from, to, days,
    totals: days.reduce((t, d) => ({ awards: t.awards + d.awards, gross_kobo: t.gross_kobo + d.gross_kobo, deduction_kobo: t.deduction_kobo + d.deduction_kobo, net_kobo: t.net_kobo + d.net_kobo }),
      { awards: 0, gross_kobo: 0, deduction_kobo: 0, net_kobo: 0 }),
    heldForAuthorityKobo: Number(held!.b),
    warning: zeroRate!.n ? "The deduction rate on winnings is 0% for at least one active campaign: confirm the statutory rate with legal and finance before real money." : null,
  };
}
