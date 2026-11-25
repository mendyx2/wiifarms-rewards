import { SYSTEM, audit } from "../audit.ts";
import type { Ctx } from "../context.ts";
import { one, withTx, type Db } from "../db.ts";
import { badRequest, conflict, notFound } from "../errors.ts";
import { accounts, post } from "../ledger.ts";
import { adminActor, requireRole, type Admin } from "./admin.ts";

/**
 * Finance: operating expenses, daily reconciliation and reports.
 *
 * Every figure here is calculated from records that cannot be edited (the
 * ledger, payments, refunds, payouts, stock and expense entries). Days follow
 * Nigerian time (Africa/Lagos).
 */

const VIEW = ["FINANCE", "AUDITOR", "COMPLIANCE"] as const;
const TZ = "Africa/Lagos";
export const EXPENSE_CATEGORIES = ["STAFF", "TECHNOLOGY", "MARKETING", "LOGISTICS", "LICENSING", "PROFESSIONAL_FEES", "PAYMENT_FEES", "OTHER"] as const;

const isDay = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(d + "T00:00:00Z"));

/** Today's date in Nigeria, as YYYY-MM-DD. */
export async function lagosToday(db: Db | Ctx["pool"]): Promise<string> {
  return (await one<{ d: string }>(db, `SELECT (now() AT TIME ZONE '${TZ}')::date::text AS d`))!.d;
}

// --- Operating expenses ----------------------------------------------------------------------

export interface NewExpense {
  category: (typeof EXPENSE_CATEGORIES)[number]; description: string; amountKobo: number; incurredOn: string;
  cycleId?: string; payee?: string; documentRef?: string;
}

export async function recordExpense(ctx: Ctx, admin: Admin, e: NewExpense): Promise<{ id: string }> {
  requireRole(admin, "FINANCE");
  if (!isDay(e.incurredOn)) throw badRequest("INVALID_DATE", "Enter the date the expense was incurred.");
  if (e.incurredOn > await lagosToday(ctx.pool)) throw badRequest("INVALID_DATE", "An expense cannot be dated in the future.");
  return withTx(ctx.pool, async (db) => {
    const r = await db.query<{ id: string }>(
      `INSERT INTO operating_expenses (cycle_id, category, description, payee, amount_kobo, incurred_on, document_ref, recorded_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [e.cycleId ?? null, e.category, e.description.trim(), e.payee?.trim() || null, e.amountKobo, e.incurredOn, e.documentRef?.trim() || null, admin.id]);
    const id = r.rows[0]!.id;
    await post(db, { kind: "EXPENSE", reference: `opex:${id}`, cycleId: e.cycleId, memo: e.description,
      debit: accounts.operatingExpense(e.category), credit: accounts.companyBank(), amountKobo: e.amountKobo });
    await audit(db, adminActor(admin), "finance.expense_recorded", "operating_expense", id, { category: e.category, amountKobo: e.amountKobo, cycleId: e.cycleId ?? null });
    return { id };
  });
}

/** Corrects a mistaken expense by recording its exact opposite. The original stays on record. */
export async function reverseExpense(ctx: Ctx, admin: Admin, expenseId: string, reason: string): Promise<{ id: string }> {
  requireRole(admin, "FINANCE");
  if (!reason.trim()) throw badRequest("REASON_REQUIRED", "Explain why the expense is being reversed.");
  return withTx(ctx.pool, async (db) => {
    const orig = await one<{ id: string; cycle_id: string | null; category: string; amount_kobo: number; reverses: string | null }>(
      db, "SELECT id, cycle_id, category, amount_kobo, reverses FROM operating_expenses WHERE id = $1", [expenseId]);
    if (!orig) throw notFound("Expense not found.");
    if (orig.reverses) throw conflict("NOT_REVERSIBLE", "A reversal cannot itself be reversed. Record a new expense instead.");
    const r = await db.query<{ id: string }>(
      `INSERT INTO operating_expenses (cycle_id, category, description, amount_kobo, incurred_on, recorded_by, reverses)
       VALUES ($1, $2, $3, $4, (now() AT TIME ZONE '${TZ}')::date, $5, $6) RETURNING id`,
      [orig.cycle_id, orig.category, "Reversal: " + reason.trim(), orig.amount_kobo, admin.id, orig.id])
      .catch((err: { code?: string }) => { if (err.code === "23505") throw conflict("ALREADY_REVERSED", "This expense has already been reversed."); throw err; });
    const id = r.rows[0]!.id;
    await post(db, { kind: "EXPENSE_REVERSAL", reference: `opex:${id}`, cycleId: orig.cycle_id ?? undefined, memo: "Reversal of " + orig.id,
      debit: accounts.companyBank(), credit: accounts.operatingExpense(orig.category), amountKobo: orig.amount_kobo });
    await audit(db, adminActor(admin), "finance.expense_reversed", "operating_expense", orig.id, { reversalId: id, reason });
    return { id };
  });
}

export async function listExpenses(ctx: Ctx, admin: Admin): Promise<unknown[]> {
  requireRole(admin, ...VIEW);
  return (await ctx.pool.query(
    `SELECT e.id, e.category, e.description, e.payee, e.amount_kobo, e.incurred_on::text, e.document_ref, e.created_at, e.reverses,
            c.name AS cycle, u.full_name AS recorded_by_name, rv.id AS reversed_by
     FROM operating_expenses e LEFT JOIN cycles c ON c.id = e.cycle_id JOIN admin_users u ON u.id = e.recorded_by
     LEFT JOIN operating_expenses rv ON rv.reverses = e.id
     ORDER BY e.created_at DESC LIMIT 300`)).rows;
}

// --- Daily reconciliation ----------------------------------------------------------------------

interface Totals { collectedKobo: number; refundedKobo: number; paidOutKobo: number }
export interface Statement { collectedKobo: number; refundedKobo: number; paidOutKobo: number }

/**
 * Money that moved through the payment provider on one day, counted twice and
 * independently: once from the payment, refund and payout records, once from
 * the ledger. With a real provider a third column, the provider's own
 * statement, is entered by Finance. In simulation the provider has no
 * statement of its own, so the check is records-versus-ledger only. Cards
 * bought from a player's wallet (and their refunds) never pass through the
 * provider, so they are not part of this check.
 */
async function dayTotals(db: Db, day: string): Promise<{ records: Totals; ledger: Totals }> {
  const inDay = (col: string) => `(${col} AT TIME ZONE '${TZ}')::date = $1::date`;
  const records = (await one<{ c: number; r: number; p: number }>(db,
    `SELECT (SELECT coalesce(sum(amount_kobo), 0) FROM payments WHERE status = 'SUCCEEDED' AND provider <> 'WALLET' AND ${inDay("verified_at")})::bigint AS c,
            (SELECT coalesce(sum(rf.amount_kobo), 0) FROM refunds rf JOIN payments p ON p.id = rf.payment_id
              WHERE rf.status = 'CONFIRMED' AND p.provider <> 'WALLET' AND coalesce(rf.provider_ref, '') NOT LIKE 'WALLET-%'
                AND ${inDay("coalesce(rf.decided_at, rf.created_at)")})::bigint AS r,
            (SELECT coalesce(sum(amount_kobo), 0) FROM payouts WHERE status = 'CONFIRMED' AND ${inDay("updated_at")})::bigint AS p`, [day]))!;
  const ledger = (await one<{ c: number; r: number; p: number }>(db,
    `SELECT coalesce(sum(e.amount_kobo) FILTER (WHERE e.amount_kobo > 0), 0)::bigint AS c,
            coalesce(-sum(e.amount_kobo) FILTER (WHERE e.amount_kobo < 0 AND t.kind = 'REFUND'), 0)::bigint AS r,
            coalesce(-sum(e.amount_kobo) FILTER (WHERE e.amount_kobo < 0 AND t.kind = 'PAYOUT'), 0)::bigint AS p
     FROM ledger_entries e JOIN ledger_transactions t ON t.id = e.transaction_id JOIN ledger_accounts a ON a.id = e.account_id
     WHERE a.code = 'GATEWAY_CLEARING' AND ${inDay("e.created_at")}`, [day]))!;
  return {
    records: { collectedKobo: records.c, refundedKobo: records.r, paidOutKobo: records.p },
    ledger: { collectedKobo: ledger.c, refundedKobo: ledger.r, paidOutKobo: ledger.p },
  };
}

const same = (a: Totals, b: Totals) => a.collectedKobo === b.collectedKobo && a.refundedKobo === b.refundedKobo && a.paidOutKobo === b.paidOutKobo;

export async function reconcileDay(ctx: Ctx, admin: Admin | null, day: string, statement?: Statement): Promise<{ day: string; status: string; figures: unknown }> {
  if (admin) requireRole(admin, "FINANCE");
  if (!isDay(day)) throw badRequest("INVALID_DATE", "Choose a valid day.");
  return withTx(ctx.pool, async (db) => {
    if (day > await lagosToday(db)) throw badRequest("INVALID_DATE", "A day in the future cannot be reconciled.");
    const existing = await one<{ signed_off_by: string | null; statement: Statement | null }>(db, "SELECT signed_off_by, statement FROM reconciliations WHERE day = $1 FOR UPDATE", [day]);
    if (existing?.signed_off_by) throw conflict("SIGNED_OFF", "This day has been signed off and cannot be reconciled again.");
    const st = statement ?? existing?.statement ?? null;
    const { records, ledger } = await dayTotals(db, day);
    const matched = same(records, ledger) && (!st || same(records, st));
    const status = matched ? "MATCHED" : "MISMATCH";
    const figures = { records, ledger, statement: st };
    await db.query(
      `INSERT INTO reconciliations (day, figures, statement, status, run_by) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (day) DO UPDATE SET figures = EXCLUDED.figures, statement = EXCLUDED.statement, status = EXCLUDED.status, run_at = now(), run_by = EXCLUDED.run_by`,
      [day, JSON.stringify(figures), st ? JSON.stringify(st) : null, status, admin?.id ?? null]);
    if (!matched && !(await one(db, "SELECT 1 FROM compliance_alerts WHERE kind = 'RECONCILIATION_MISMATCH' AND entity_id = $1 AND status = 'OPEN'", [day]))) {
      await db.query("INSERT INTO compliance_alerts (kind, severity, entity_type, entity_id, details) VALUES ('RECONCILIATION_MISMATCH', 'CRITICAL', 'reconciliation', $1, $2)",
        [day, JSON.stringify(figures)]);
    }
    await audit(db, admin ? adminActor(admin) : SYSTEM, "finance.reconciled", "reconciliation", day, { status, ...figures });
    return { day, status, figures };
  });
}

export async function signOffDay(ctx: Ctx, admin: Admin, day: string, note?: string): Promise<{ day: string; status: string }> {
  requireRole(admin, "FINANCE");
  return withTx(ctx.pool, async (db) => {
    const r = await one<{ status: string; signed_off_by: string | null }>(db, "SELECT status, signed_off_by FROM reconciliations WHERE day = $1 FOR UPDATE", [day]);
    if (!r) throw notFound("This day has not been reconciled yet.");
    if (r.signed_off_by) throw conflict("SIGNED_OFF", "This day has already been signed off.");
    if (r.status !== "MATCHED" && !note?.trim()) throw badRequest("NOTE_REQUIRED", "The figures do not match. Explain the difference before signing off.");
    await db.query("UPDATE reconciliations SET signed_off_by = $2, signed_off_at = now(), note = $3 WHERE day = $1", [day, admin.id, note?.trim() || null]);
    await audit(db, adminActor(admin), "finance.reconciliation_signed_off", "reconciliation", day, { status: r.status, note: note ?? null });
    return { day, status: r.status };
  });
}

export async function listReconciliations(ctx: Ctx, admin: Admin): Promise<unknown> {
  requireRole(admin, ...VIEW);
  const rows = (await ctx.pool.query(
    `SELECT r.day::text, r.figures, r.status, r.run_at, r.signed_off_at, r.note, u.full_name AS signed_off_by_name
     FROM reconciliations r LEFT JOIN admin_users u ON u.id = r.signed_off_by ORDER BY r.day DESC LIMIT 60`)).rows;
  // Days with money movement that nobody has reconciled yet.
  const missing = (await ctx.pool.query<{ day: string }>(
    `SELECT DISTINCT (e.created_at AT TIME ZONE '${TZ}')::date::text AS day
     FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id
     WHERE a.code = 'GATEWAY_CLEARING' AND NOT EXISTS (SELECT 1 FROM reconciliations r WHERE r.day = (e.created_at AT TIME ZONE '${TZ}')::date)
     ORDER BY 1 DESC LIMIT 60`)).rows.map((r) => r.day);
  return { days: rows, notReconciled: missing, today: await lagosToday(ctx.pool) };
}

/** Run daily: reconciles yesterday automatically so a person only has to review and sign off. */
export async function reconcileYesterday(ctx: Ctx): Promise<void> {
  const day = (await one<{ d: string }>(ctx.pool, `SELECT ((now() AT TIME ZONE '${TZ}')::date - 1)::text AS d`))!.d;
  const r = await one<{ signed_off_by: string | null }>(ctx.pool, "SELECT signed_off_by FROM reconciliations WHERE day = $1", [day]);
  if (!r?.signed_off_by) await reconcileDay(ctx, null, day);
}

// --- Reports --------------------------------------------------------------------------------------

export interface CycleResult {
  id: string; name: string; status: string; cards_sold: number;
  gross_sales_kobo: number; refunds_kobo: number; net_revenue_kobo: number;
  instant_prizes_kobo: number; draw_cash_prizes_kobo: number; forfeited_prizes_kobo: number;
  merchandise_cost_kobo: number; operating_expenses_kobo: number; contribution_kobo: number;
  /** Paid to referrers from the operator's share under the earlier model (net of reversals). */
  referral_commissions_kobo: number;
  /** Affiliate marketing fees, from the operator's share (net of reversals). */
  affiliate_fees_kobo: number;
  /** Withheld from cash prizes for the authority (part of the prize cost; instant and draw prizes are what reached winners). */
  statutory_deductions_kobo: number;
  /** Part of net revenue paid from players' wallets rather than through the payment provider. */
  wallet_sales_kobo: number;
  prize_payout_ratio: number | null;
}

/**
 * Results for every cycle. Cash prizes come from the ledger; merchandise is
 * counted at the landed cost of the units committed to the cycle (its stock
 * records, since the ledger does not hold inventory); expenses are those
 * recorded against the cycle.
 */
export async function cycleResults(ctx: Ctx, admin: Admin): Promise<CycleResult[]> {
  requireRole(admin, ...VIEW);
  const r = await ctx.pool.query<Omit<CycleResult, "contribution_kobo" | "prize_payout_ratio">>(
    `WITH le AS (
       SELECT a.code, t.kind, sum(e.amount_kobo) AS amt
       FROM ledger_entries e JOIN ledger_transactions t ON t.id = e.transaction_id JOIN ledger_accounts a ON a.id = e.account_id
       WHERE a.code LIKE 'TICKET_REVENUE:%' OR a.code LIKE 'PRIZE_EXPENSE:%' OR a.code LIKE 'REFERRAL_EXPENSE:%' OR a.code LIKE 'AFFILIATE_EXPENSE:%' GROUP BY a.code, t.kind)
     SELECT c.id, c.name, c.status,
       (SELECT count(*) FROM tickets t WHERE t.cycle_id = c.id AND t.status IN ('SOLD','REVEALED'))::int AS cards_sold,
       (SELECT coalesce(sum(amount_kobo), 0) FROM orders o WHERE o.cycle_id = c.id AND o.status IN ('FULFILLED','REFUNDED')
          AND EXISTS (SELECT 1 FROM payments p WHERE p.order_id = o.id AND p.status = 'SUCCEEDED'))::bigint AS gross_sales_kobo,
       (SELECT coalesce(sum(rf.amount_kobo), 0) FROM refunds rf JOIN orders o ON o.id = rf.order_id WHERE o.cycle_id = c.id AND rf.status = 'CONFIRMED')::bigint AS refunds_kobo,
       (0 - coalesce((SELECT sum(amt) FROM le WHERE code = 'TICKET_REVENUE:' || c.id), 0))::bigint AS net_revenue_kobo,
       coalesce((SELECT sum(amt) FROM le WHERE code = 'PRIZE_EXPENSE:' || c.id AND kind = 'INSTANT_PRIZE'), 0)::bigint AS instant_prizes_kobo,
       coalesce((SELECT sum(amt) FROM le WHERE code = 'PRIZE_EXPENSE:' || c.id AND kind = 'DRAW_PRIZE'), 0)::bigint AS draw_cash_prizes_kobo,
       (0 - coalesce((SELECT sum(amt) FROM le WHERE code = 'PRIZE_EXPENSE:' || c.id AND kind = 'ADJUSTMENT'), 0))::bigint AS forfeited_prizes_kobo,
       (SELECT coalesce(sum(landed_cost_kobo), 0) FROM stock_units u WHERE u.reserved_cycle_id = c.id AND u.status <> 'IN_STOCK')::bigint AS merchandise_cost_kobo,
       coalesce((SELECT sum(amt) FROM le WHERE code = 'REFERRAL_EXPENSE:' || c.id), 0)::bigint AS referral_commissions_kobo,
       coalesce((SELECT sum(amt) FROM le WHERE code = 'AFFILIATE_EXPENSE:' || c.id), 0)::bigint AS affiliate_fees_kobo,
       coalesce((SELECT sum(amt) FROM le WHERE code = 'PRIZE_EXPENSE:' || c.id AND kind IN ('TAX','TAX_REVERSAL')), 0)::bigint AS statutory_deductions_kobo,
       (SELECT coalesce(sum(o.amount_kobo), 0) FROM orders o JOIN payments p ON p.order_id = o.id AND p.status = 'SUCCEEDED' AND p.provider = 'WALLET'
          WHERE o.cycle_id = c.id AND o.status = 'FULFILLED')::bigint AS wallet_sales_kobo,
       (SELECT coalesce(sum(CASE WHEN x.reverses IS NULL THEN x.amount_kobo ELSE -x.amount_kobo END), 0) FROM operating_expenses x WHERE x.cycle_id = c.id)::bigint AS operating_expenses_kobo
     FROM cycles c ORDER BY c.created_at DESC`);
  return r.rows.map((c) => {
    const prizes = c.instant_prizes_kobo + c.draw_cash_prizes_kobo + c.statutory_deductions_kobo - c.forfeited_prizes_kobo + c.merchandise_cost_kobo;
    return {
      ...c,
      contribution_kobo: c.net_revenue_kobo - prizes - c.referral_commissions_kobo - c.affiliate_fees_kobo - c.operating_expenses_kobo,
      prize_payout_ratio: c.net_revenue_kobo > 0 ? Math.round((prizes / c.net_revenue_kobo) * 1000) / 1000 : null,
    };
  });
}

/** Totals for a date range across all cycles, plus company overheads. */
export async function periodSummary(ctx: Ctx, admin: Admin, from: string, to: string): Promise<unknown> {
  requireRole(admin, ...VIEW);
  if (!isDay(from) || !isDay(to) || from > to) throw badRequest("INVALID_DATE", "Choose a valid date range.");
  const inRange = (col: string) => `(${col} AT TIME ZONE '${TZ}')::date BETWEEN $1::date AND $2::date`;
  const s = (await one<Record<string, number>>(ctx.pool,
    `SELECT
       (SELECT coalesce(sum(amount_kobo), 0) FROM payments WHERE status = 'SUCCEEDED' AND provider <> 'WALLET' AND ${inRange("verified_at")})::bigint AS collected_kobo,
       (SELECT coalesce(sum(amount_kobo), 0) FROM payments WHERE status = 'SUCCEEDED' AND provider = 'WALLET' AND ${inRange("verified_at")})::bigint AS wallet_sales_kobo,
       (SELECT coalesce(sum(rf.amount_kobo), 0) FROM refunds rf JOIN payments p ON p.id = rf.payment_id WHERE rf.status = 'CONFIRMED'
          AND p.provider <> 'WALLET' AND coalesce(rf.provider_ref, '') NOT LIKE 'WALLET-%' AND ${inRange("coalesce(rf.decided_at, rf.created_at)")})::bigint AS refunded_kobo,
       (SELECT coalesce(sum(rf.amount_kobo), 0) FROM refunds rf JOIN payments p ON p.id = rf.payment_id WHERE rf.status = 'CONFIRMED'
          AND (p.provider = 'WALLET' OR rf.provider_ref LIKE 'WALLET-%') AND ${inRange("coalesce(rf.decided_at, rf.created_at)")})::bigint AS refunded_to_wallets_kobo,
       (SELECT coalesce(sum(e.amount_kobo), 0) FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id
          WHERE a.code LIKE 'REFERRAL_EXPENSE:%' AND ${inRange("e.created_at")})::bigint AS referral_commissions_kobo,
       (SELECT coalesce(sum(e.amount_kobo), 0) FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id
          WHERE a.code LIKE 'AFFILIATE_EXPENSE:%' AND ${inRange("e.created_at")})::bigint AS affiliate_fees_kobo,
       (SELECT coalesce(sum(e.amount_kobo), 0) FROM ledger_entries e JOIN ledger_transactions t ON t.id = e.transaction_id JOIN ledger_accounts a ON a.id = e.account_id
          WHERE a.code LIKE 'PRIZE_EXPENSE:%' AND t.kind IN ('TAX','TAX_REVERSAL') AND ${inRange("e.created_at")})::bigint AS statutory_deductions_kobo,
       (SELECT coalesce(sum(e.amount_kobo), 0) FROM ledger_entries e JOIN ledger_transactions t ON t.id = e.transaction_id JOIN ledger_accounts a ON a.id = e.account_id
          WHERE a.code LIKE 'PRIZE_EXPENSE:%' AND ${inRange("e.created_at")})::bigint AS cash_prizes_kobo,
       (SELECT coalesce(sum(amount_kobo), 0) FROM payouts WHERE status = 'CONFIRMED' AND ${inRange("updated_at")})::bigint AS paid_out_kobo,
       (SELECT coalesce(sum(CASE WHEN reverses IS NULL THEN amount_kobo ELSE -amount_kobo END), 0) FROM operating_expenses WHERE incurred_on BETWEEN $1::date AND $2::date)::bigint AS operating_expenses_kobo,
       (SELECT count(*) FROM orders WHERE status IN ('FULFILLED','REFUNDED') AND ${inRange("created_at")})::int AS purchases,
       (SELECT count(*) FROM reconciliations WHERE day BETWEEN $1::date AND $2::date AND signed_off_by IS NOT NULL)::int AS days_signed_off,
       (SELECT count(*) FROM reconciliations WHERE day BETWEEN $1::date AND $2::date AND status = 'MISMATCH')::int AS days_mismatched`, [from, to]))!;
  const byCategory = (await ctx.pool.query(
    `SELECT category, sum(CASE WHEN reverses IS NULL THEN amount_kobo ELSE -amount_kobo END)::bigint AS amount_kobo
     FROM operating_expenses WHERE incurred_on BETWEEN $1::date AND $2::date GROUP BY category ORDER BY 2 DESC`, [from, to])).rows;
  const net = s.collected_kobo! + s.wallet_sales_kobo! - s.refunded_kobo! - s.refunded_to_wallets_kobo!;
  return { from, to, ...s, net_sales_kobo: net, result_kobo: net - s.cash_prizes_kobo! - s.referral_commissions_kobo! - s.affiliate_fees_kobo! - s.operating_expenses_kobo!, expensesByCategory: byCategory,
    note: "Cash prizes are counted when awarded. Merchandise prize costs are shown per cycle in the cycle results. Cash prizes include the statutory deductions withheld from them. Sales include cards bought from players' wallets; affiliate fees (and referral commissions under the earlier model) are paid from the operator's share." };
}

// --- Spreadsheet export ----------------------------------------------------------------------------

/**
 * CSV with protection against formula injection: a cell that starts with
 * = + - @ (or a tab/return) is prefixed so spreadsheet programs show it as text
 * instead of running it. Cycle names and descriptions are typed by staff.
 */
export function toCsv(header: string[], rows: (string | number | null | undefined)[][]): string {
  const cell = (v: string | number | null | undefined): string => {
    if (v === null || v === undefined) return "";
    let s = String(v);
    if (typeof v === "string" && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [header, ...rows].map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
}

// Numbers stay numbers (so negative amounts are not mistaken for formulas).
const naira = (kobo: number): number => Math.round(kobo) / 100;

export async function cycleResultsCsv(ctx: Ctx, admin: Admin): Promise<string> {
  const rows = await cycleResults(ctx, admin);
  return toCsv(
    ["Cycle", "Status", "Cards sold", "Gross sales (NGN)", "Refunds (NGN)", "Net revenue (NGN)", "Instant prizes (NGN)", "Draw cash prizes (NGN)",
      "Statutory deductions (NGN)", "Forfeited prizes (NGN)", "Merchandise at landed cost (NGN)", "Referral commissions (NGN)", "Affiliate fees (NGN)", "Operating expenses (NGN)", "Contribution (NGN)", "Prize payout ratio"],
    rows.map((c) => [c.name, c.status, c.cards_sold, naira(c.gross_sales_kobo), naira(c.refunds_kobo), naira(c.net_revenue_kobo), naira(c.instant_prizes_kobo),
      naira(c.draw_cash_prizes_kobo), naira(c.statutory_deductions_kobo), naira(c.forfeited_prizes_kobo), naira(c.merchandise_cost_kobo), naira(c.referral_commissions_kobo),
      naira(c.affiliate_fees_kobo), naira(c.operating_expenses_kobo), naira(c.contribution_kobo),
      c.prize_payout_ratio === null ? "" : c.prize_payout_ratio]));
}

export async function expensesCsv(ctx: Ctx, admin: Admin): Promise<string> {
  const rows = (await listExpenses(ctx, admin)) as Record<string, string | number | null>[];
  return toCsv(["Date", "Category", "Description", "Payee", "Cycle", "Amount (NGN)", "Document", "Recorded by", "Reverses"],
    rows.map((e) => [e.incurred_on, e.category, e.description, e.payee, e.cycle, naira((e.reverses ? -1 : 1) * Number(e.amount_kobo)), e.document_ref, e.recorded_by_name, e.reverses]));
}
