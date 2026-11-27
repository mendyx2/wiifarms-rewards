import type { Ctx } from "../context.ts";
import { one } from "../db.ts";
import { badRequest, notFound } from "../errors.ts";
import { requireRole, type Admin, type Role } from "./admin.ts";
import { cycleResults, toCsv } from "./finance.ts";
import { reconciliation as centreReconciliation } from "./stockists.ts";

/**
 * The management reports the SRS lists (section 15), each with its stated
 * frequency. Every figure comes from records and the ledger; nothing is typed
 * in. Each report is a table that can be read on screen or downloaded as a
 * spreadsheet (CSV). Players are never identified in any report.
 */

type Kind = "text" | "int" | "kobo" | "date" | "pct";
interface Column { key: string; label: string; kind: Kind }
type Row = Record<string, string | number | boolean | null>;
interface Params { from: string; to: string; cycleId?: string | undefined }
interface ReportDef {
  id: string; title: string; frequency: string; description: string; roles: Role[]; needs: "range" | "cycle" | "none";
  columns: Column[];
  run(ctx: Ctx, p: Params): Promise<{ rows: Row[]; notes?: string[] }>;
}

const TZ = "Africa/Lagos";
const inRange = (col: string) => `(${col} AT TIME ZONE '${TZ}')::date BETWEEN $1::date AND $2::date`;
const FIN: Role[] = ["FINANCE", "AUDITOR", "COMPLIANCE"];
const FUL: Role[] = ["FULFILMENT", "FINANCE", "AUDITOR", "COMPLIANCE"];
const k = (v: unknown) => Number(v ?? 0);
const c = (key: string, label: string, kind: Kind = "text"): Column => ({ key, label, kind });

/** Alert kinds that are security incidents (reported at once; listed in the security incidents report). */
export const SECURITY_ALERTS = ["ADMIN_MFA_LOCKED", "HANDOVER_CODE_FAILURES", "SHARED_BANK_ACCOUNT", "PAYMENT_AMOUNT_MISMATCH", "DISPUTED_PAYMENT",
  "EXCLUDED_PERSON_PRIZE", "DRAW_REPORT_CHECK_FAILED", "RECONCILIATION_MISMATCH", "LICENCE_REVOKED", "REFERRAL_VELOCITY", "AFFILIATE_VELOCITY"];

const REPORTS: ReportDef[] = [
  {
    id: "payment-reconciliation", title: "Payment reconciliation", frequency: "Daily", roles: FIN, needs: "range",
    description: "Each day's money through the payment provider, from the payment, refund and payout records and separately from the ledger, with the sign-off.",
    columns: [c("day", "Day", "date"), c("status", "Result"), c("collected", "Collected (records)", "kobo"), c("collected_ledger", "Collected (ledger)", "kobo"),
      c("refunded", "Refunded", "kobo"), c("paid_out", "Paid out", "kobo"), c("signed_off_by", "Signed off by"), c("note", "Note")],
    async run(ctx, p) {
      const rows = (await ctx.pool.query(
        `SELECT r.day::text, r.status, r.figures, a.full_name AS signed_off_by, r.note FROM reconciliations r LEFT JOIN admin_users a ON a.id = r.signed_off_by
         WHERE r.day BETWEEN $1::date AND $2::date ORDER BY r.day`, [p.from, p.to])).rows;
      return { rows: rows.map((r) => ({ day: r.day, status: r.status, collected: k(r.figures.records.collectedKobo), collected_ledger: k(r.figures.ledger.collectedKobo),
        refunded: k(r.figures.records.refundedKobo), paid_out: k(r.figures.records.paidOutKobo), signed_off_by: r.signed_off_by ?? "Not yet", note: r.note })) };
    },
  },
  {
    id: "merchandise-liabilities", title: "Merchandise liabilities", frequency: "Daily", roles: FUL, needs: "none",
    description: "Merchandise prizes owed to winners and still to be won, by campaign and item: won but not yet handed over, and reserved for draws still to come.",
    columns: [c("campaign", "Campaign"), c("item", "Item"), c("won_waiting", "Won, not yet handed over", "int"), c("to_be_drawn", "Still to be drawn", "int"),
      c("value", "Published value owed", "kobo"), c("landed_cost", "Landed cost of reserved units", "kobo")],
    async run(ctx) {
      const rows = (await ctx.pool.query(
        `SELECT c.name AS campaign, k.name AS item, k.advertised_value_kobo,
                (SELECT count(*) FROM prize_claims pc WHERE pc.prize_tier_id = p.id AND pc.status IN ('ENTITLED','ON_HOLD','VERIFIED','DISPATCHED'))::int AS won_waiting,
                CASE WHEN c.status IN ('APPROVED','COMMITTED','OPEN','CLOSED') THEN p.quantity ELSE 0 END AS to_be_drawn,
                (SELECT coalesce(sum(u.landed_cost_kobo), 0) FROM stock_units u WHERE u.sku_id = p.sku_id AND u.reserved_cycle_id = c.id AND u.status IN ('RESERVED','ALLOCATED','DISPATCHED'))::bigint AS landed
         FROM prize_tiers p JOIN cycles c ON c.id = p.cycle_id JOIN skus k ON k.id = p.sku_id
         WHERE p.kind = 'MERCHANDISE' AND c.status NOT IN ('DRAFT','SUBMITTED','VOID','ARCHIVED') ORDER BY c.name, k.name`)).rows;
      return { rows: rows.filter((r) => r.won_waiting || r.to_be_drawn).map((r) => ({ campaign: r.campaign, item: r.item, won_waiting: r.won_waiting, to_be_drawn: r.to_be_drawn,
        value: (r.won_waiting + r.to_be_drawn) * k(r.advertised_value_kobo), landed_cost: k(r.landed) })) };
    },
  },
  {
    id: "supplier-invoices", title: "Supplier invoices", frequency: "Daily", roles: FUL, needs: "range",
    description: "Prize stock received from suppliers in the period, by purchase order, at acquisition and landed cost, with the invoice document reference.",
    columns: [c("received", "Received", "date"), c("supplier", "Supplier"), c("po", "Purchase order"), c("item", "Item"), c("units", "Units", "int"),
      c("acquisition", "Acquisition cost", "kobo"), c("landed", "Landed cost", "kobo"), c("document", "Invoice document")],
    async run(ctx, p) {
      const rows = (await ctx.pool.query(
        `SELECT po.received_at::text AS received, sp.name AS supplier, po.reference AS po, k.name AS item, count(*)::int AS units,
                sum(u.acquisition_cost_kobo)::bigint AS acquisition, sum(u.landed_cost_kobo)::bigint AS landed, po.document_ref AS document
         FROM stock_units u JOIN purchase_orders po ON po.id = u.purchase_order_id JOIN suppliers sp ON sp.id = po.supplier_id JOIN skus k ON k.id = u.sku_id
         WHERE po.received_at BETWEEN $1::date AND $2::date GROUP BY po.id, sp.name, k.name ORDER BY po.received_at, sp.name`, [p.from, p.to])).rows;
      return { rows: rows.map((r) => ({ ...r, acquisition: k(r.acquisition), landed: k(r.landed) })) };
    },
  },
  {
    id: "stockist-fulfilment", title: "Stockist fulfilment", frequency: "Daily", roles: FUL, needs: "range",
    description: "Per collection centre: prizes handed over in the period, vouchers waiting, stock on the shelf, open problem reports, fees and any record that does not add up.",
    columns: [c("centre", "Centre"), c("handed_over_period", "Handed over in period", "int"), c("awaiting", "Awaiting collection", "int"), c("on_shelf", "On the shelf", "int"),
      c("open_incidents", "Open problem reports", "int"), c("fees_period", "Fees earned in period", "kobo"), c("mismatches", "Mismatches", "int")],
    async run(ctx, p) {
      const all = (await centreReconciliation(ctx, { id: "", email: "", fullName: "", roles: ["AUDITOR"] }) as { centres: Row[] }).centres;
      const period = (await ctx.pool.query(
        `SELECT sh.stockist_id, count(*)::int AS n, coalesce(sum(f.amount_kobo), 0)::bigint AS fees FROM shipments sh LEFT JOIN stockist_fees f ON f.shipment_id = sh.id
         WHERE sh.stockist_id IS NOT NULL AND sh.status = 'HANDED_OVER' AND ${inRange("sh.handed_over_at")} GROUP BY sh.stockist_id`, [p.from, p.to])).rows;
      return { rows: all.map((r) => { const x = period.find((q) => q.stockist_id === r.id);
        return { centre: `${r.code} · ${r.name}`, handed_over_period: x?.n ?? 0, awaiting: r.awaiting_collection as number, on_shelf: r.on_shelf as number,
          open_incidents: r.open_incidents as number, fees_period: k(x?.fees), mismatches: r.mismatches as number }; }) };
    },
  },
  {
    id: "campaign-profitability", title: "Campaign profitability", frequency: "Daily", roles: FIN, needs: "none",
    description: "Per campaign: net revenue, prizes (cash awarded, statutory deductions, merchandise at landed cost), referral earnings, operating expenses and contribution.",
    columns: [c("campaign", "Campaign"), c("status", "Status"), c("cards_sold", "Cards sold", "int"), c("net_revenue", "Net revenue", "kobo"), c("cash_prizes", "Cash prizes", "kobo"),
      c("deductions", "Statutory deductions", "kobo"), c("merchandise", "Merchandise (landed)", "kobo"), c("referrals", "Referral earnings", "kobo"),
      c("operating", "Operating expenses", "kobo"), c("contribution", "Contribution", "kobo"), c("payout_ratio", "Prize payout ratio", "pct")],
    async run(ctx) {
      const rows = await cycleResults(ctx, { id: "", email: "", fullName: "", roles: ["AUDITOR"] });
      return { rows: rows.map((r) => ({ campaign: r.name, status: r.status, cards_sold: r.cards_sold, net_revenue: k(r.net_revenue_kobo),
        cash_prizes: k(r.instant_prizes_kobo) + k(r.draw_cash_prizes_kobo) - k(r.forfeited_prizes_kobo), deductions: k(r.statutory_deductions_kobo),
        merchandise: k(r.merchandise_cost_kobo), referrals: k(r.referral_commissions_kobo) + k(r.affiliate_fees_kobo), operating: k(r.operating_expenses_kobo), contribution: k(r.contribution_kobo),
        payout_ratio: r.prize_payout_ratio })) };
    },
  },
  {
    id: "statutory-deductions", title: "Statutory deductions", frequency: "Daily", roles: FIN, needs: "range",
    description: "Deductions withheld from cash prizes, per day and campaign, and the amount held for the authority.",
    columns: [c("day", "Day", "date"), c("campaign", "Campaign"), c("rate", "Rate", "pct"), c("awards", "Cash awards", "int"), c("gross", "Gross", "kobo"),
      c("withheld", "Withheld", "kobo"), c("net", "Paid to winners", "kobo")],
    async run(ctx, p) {
      const rows = (await ctx.pool.query(
        `SELECT (d.created_at AT TIME ZONE '${TZ}')::date::text AS day, c.name AS campaign, d.rate_bp, count(*)::int AS awards,
                sum(d.gross_kobo)::bigint AS gross, sum(d.deduction_kobo)::bigint AS withheld, sum(d.net_kobo)::bigint AS net
         FROM prize_deductions d JOIN cycles c ON c.id = d.cycle_id WHERE d.status = 'DEDUCTED' AND ${inRange("d.created_at")} GROUP BY 1, 2, 3 ORDER BY 1, 2`, [p.from, p.to])).rows;
      const held = await one<{ b: string }>(ctx.pool, "SELECT -coalesce(sum(e.amount_kobo), 0)::bigint AS b FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id WHERE a.code = 'STATUTORY_DEDUCTIONS_PAYABLE'");
      return { rows: rows.map((r) => ({ day: r.day, campaign: r.campaign, rate: r.rate_bp / 10_000, awards: r.awards, gross: k(r.gross), withheld: k(r.withheld), net: k(r.net) })),
        notes: [`Held for the tax authority now: ₦${(k(held?.b) / 100).toLocaleString("en-NG")}.`] };
    },
  },
  {
    id: "ticket-reconciliation", title: "Ticket reconciliation", frequency: "Real time / daily", roles: FIN, needs: "none",
    description: "Per campaign: every card accounted for (unsold, held, sold, cancelled), the cards in paid purchases, and the ticket revenue in the ledger. Any difference is flagged.",
    columns: [c("campaign", "Campaign"), c("total", "Cards", "int"), c("unsold", "Unsold", "int"), c("held", "Held for payment", "int"), c("sold", "Sold", "int"),
      c("cancelled", "Cancelled", "int"), c("paid_cards", "Cards in paid purchases", "int"), c("sales_value", "Sold × price", "kobo"), c("ledger_revenue", "Ledger ticket revenue", "kobo"),
      c("check", "Check")],
    async run(ctx) {
      const rows = (await ctx.pool.query(
        `SELECT c.name AS campaign, c.total_tickets AS total, c.ticket_price_kobo AS price,
                count(t.*) FILTER (WHERE t.status = 'UNSOLD')::int AS unsold, count(t.*) FILTER (WHERE t.status = 'RESERVED')::int AS held,
                count(t.*) FILTER (WHERE t.status IN ('SOLD','REVEALED'))::int AS sold, count(t.*) FILTER (WHERE t.status = 'CANCELLED')::int AS cancelled,
                count(t.*)::int AS counted,
                (SELECT count(*) FROM tickets x JOIN orders o ON o.id = x.order_id WHERE x.cycle_id = c.id AND x.status IN ('SOLD','REVEALED')
                   AND EXISTS (SELECT 1 FROM payments pm WHERE pm.order_id = o.id AND pm.status = 'SUCCEEDED'))::int AS paid_cards,
                -coalesce((SELECT balance_kobo FROM ledger_balances WHERE code = 'TICKET_REVENUE:' || c.id), 0)::bigint AS ledger_revenue
         FROM cycles c LEFT JOIN tickets t ON t.cycle_id = c.id WHERE c.status NOT IN ('DRAFT','SUBMITTED','APPROVED') GROUP BY c.id ORDER BY c.created_at DESC`)).rows;
      return { rows: rows.map((r) => {
        const salesValue = r.sold * k(r.price);
        const ok = r.counted === r.total && r.paid_cards === r.sold && salesValue === k(r.ledger_revenue);
        return { campaign: r.campaign, total: r.total, unsold: r.unsold, held: r.held, sold: r.sold, cancelled: r.cancelled, paid_cards: r.paid_cards,
          sales_value: salesValue, ledger_revenue: k(r.ledger_revenue), check: ok ? "Matches" : "DIFFERENCE" };
      }), notes: ["Held cards are waiting for a payment in progress (at most 15 minutes)."] };
    },
  },
  {
    id: "cash-prize-liability", title: "Cash prize liability", frequency: "Real time", roles: FIN, needs: "none",
    description: "Cash still owed: winnings in players' wallets, withdrawals in progress, instant wins revealed but not yet accepted, instant cash still in unscratched or unsold cards, and Mega Draw cash not yet drawn.",
    columns: [c("item", "Liability"), c("amount", "Amount", "kobo")],
    async run(ctx) {
      const t = (await one<Record<string, string>>(ctx.pool,
        `SELECT -coalesce((SELECT sum(balance_kobo) FROM ledger_balances WHERE code LIKE 'PLAYER_WINNINGS:%'), 0)::bigint AS wallets,
                -coalesce((SELECT balance_kobo FROM ledger_balances WHERE code = 'PAYOUTS_IN_TRANSIT'), 0)::bigint AS transit,
                -coalesce((SELECT balance_kobo FROM ledger_balances WHERE code = 'STATUTORY_DEDUCTIONS_PAYABLE'), 0)::bigint AS deductions,
                (SELECT coalesce(sum(split_part(t.revealed_outcome, ':', 2)::bigint), 0) FROM tickets t JOIN cycles c ON c.id = t.cycle_id
                   WHERE t.status = 'REVEALED' AND t.revealed_outcome LIKE 'CASH:%' AND t.prize_accepted_at IS NULL)::bigint AS unaccepted,
                (SELECT coalesce(sum(p.cash_kobo * p.quantity), 0) FROM prize_tiers p JOIN cycles c ON c.id = p.cycle_id
                   WHERE p.stage = 'INSTANT' AND c.status IN ('COMMITTED','OPEN','CLOSED'))::bigint
                  - (SELECT coalesce(sum(pt.cash_kobo), 0) FROM prize_claims pc JOIN prize_tiers pt ON pt.id = pc.prize_tier_id JOIN cycles c ON c.id = pt.cycle_id
                   WHERE pc.stage = 'INSTANT' AND c.status IN ('COMMITTED','OPEN','CLOSED'))::bigint
                  - (SELECT coalesce(sum(split_part(t.revealed_outcome, ':', 2)::bigint), 0) FROM tickets t JOIN cycles c ON c.id = t.cycle_id
                   WHERE t.status = 'REVEALED' AND t.revealed_outcome LIKE 'CASH:%' AND t.prize_accepted_at IS NULL AND c.status IN ('COMMITTED','OPEN','CLOSED'))::bigint AS unscratched,
                (SELECT coalesce(sum(p.cash_kobo * p.quantity), 0) FROM prize_tiers p JOIN cycles c ON c.id = p.cycle_id
                   WHERE p.stage = 'FINAL_DRAW' AND p.kind = 'CASH' AND c.status IN ('APPROVED','COMMITTED','OPEN','CLOSED'))::bigint AS undrawn`))!;
      const rows = [
        { item: "Winnings in players' wallets", amount: k(t.wallets) },
        { item: "Withdrawals in progress", amount: k(t.transit) },
        { item: "Instant wins revealed, not yet accepted", amount: k(t.unaccepted) },
        { item: "Instant cash in unscratched or unsold cards (live campaigns)", amount: Math.max(0, k(t.unscratched)) },
        { item: "Mega Draw cash not yet drawn", amount: k(t.undrawn) },
        { item: "Statutory deductions held for the authority", amount: k(t.deductions) },
      ];
      return { rows: [...rows, { item: "Total", amount: rows.reduce((s, r) => s + r.amount, 0) }] };
    },
  },
  {
    id: "referral-earnings", title: "Referral earnings", frequency: "As applicable", roles: FIN, needs: "range",
    description: "Per player whose link brought in buyers, for the period: friends who joined, cards they bought, earnings paid into the wallet (10% of each card) and earnings taken back on refunds. Players are shown by code, not name.",
    columns: [c("code", "Player code"), c("friends", "Friends joined", "int"), c("cards", "Cards bought by friends", "int"), c("earned", "Earned", "kobo"),
      c("reversed", "Taken back", "kobo"), c("stopped", "Earnings stopped")],
    async run(ctx, p) {
      const rows = (await ctx.pool.query(
        `SELECT u.referral_code AS code, u.referral_earnings_blocked AS stopped,
                (SELECT count(*) FROM users x WHERE x.referred_by = u.id AND ${inRange("x.created_at")})::int AS friends,
                coalesce(sum(r.cards) FILTER (WHERE r.status = 'EARNED' AND ${inRange("r.created_at")}), 0)::int AS cards,
                coalesce(sum(r.amount_kobo) FILTER (WHERE ${inRange("r.created_at")}), 0)::bigint AS earned,
                coalesce(sum(r.amount_kobo) FILTER (WHERE r.status = 'REVERSED' AND ${inRange("r.reversed_at")}), 0)::bigint AS reversed
         FROM referral_commissions r JOIN users u ON u.id = r.referrer_id GROUP BY u.id ORDER BY earned DESC LIMIT 1000`, [p.from, p.to])).rows;
      return { rows: rows.map((r) => ({ code: r.code, friends: r.friends, cards: r.cards, earned: k(r.earned), reversed: k(r.reversed), stopped: r.stopped ? "Yes" : "" })),
        notes: [`Every player earns ${(ctx.config.policy?.referralBp ?? 1000) / 100}% of the cards bought by friends who joined with their link, paid into their wallet from the operator's share.`] };
    },
  },
  {
    id: "regulatory-returns", title: "Regulatory returns", frequency: "Prescribed frequency", roles: ["COMPLIANCE", "AUDITOR", "FINANCE"], needs: "range",
    description: "Per licensed state for the period: sales, refunds, prizes awarded, deductions withheld, players, responsible-play actions and complaints. The format the authority prescribes is to be confirmed.",
    columns: [c("state", "State"), c("campaigns", "Campaigns selling", "int"), c("cards_sold", "Cards sold", "int"), c("gross_sales", "Gross sales", "kobo"),
      c("refunds", "Refunds", "kobo"), c("cash_prizes", "Cash prizes awarded", "kobo"), c("merch_prizes", "Merchandise prizes awarded", "int"), c("deductions", "Deductions withheld", "kobo"),
      c("new_players", "New verified players", "int"), c("active_players", "Players who bought", "int"), c("breaks", "Breaks and self-exclusions started", "int"),
      c("complaints", "Complaints received", "int"), c("complaints_closed", "Complaints closed", "int")],
    async run(ctx, p) {
      const rows = (await ctx.pool.query(
        `SELECT c.state_code AS state,
                count(DISTINCT o.cycle_id) FILTER (WHERE o.status IN ('FULFILLED','REFUNDED'))::int AS campaigns,
                coalesce(sum(o.quantity) FILTER (WHERE o.status IN ('FULFILLED','REFUNDED')), 0)::int AS cards_sold,
                coalesce(sum(o.amount_kobo) FILTER (WHERE o.status IN ('FULFILLED','REFUNDED')), 0)::bigint AS gross_sales,
                count(DISTINCT o.user_id) FILTER (WHERE o.status IN ('FULFILLED','REFUNDED'))::int AS active_players
         FROM orders o JOIN cycles c ON c.id = o.cycle_id WHERE ${inRange("o.created_at")} GROUP BY c.state_code`, [p.from, p.to])).rows;
      const states = new Set<string>(["NG-NI", ...rows.map((r) => r.state as string)]);
      const out: Row[] = [];
      for (const st of states) {
        const r = rows.find((x) => x.state === st) ?? { campaigns: 0, cards_sold: 0, gross_sales: 0, active_players: 0 };
        const x = (await one<Record<string, string>>(ctx.pool,
          `SELECT (SELECT coalesce(sum(rf.amount_kobo), 0) FROM refunds rf JOIN orders o ON o.id = rf.order_id JOIN cycles c ON c.id = o.cycle_id
                    WHERE c.state_code = $3 AND rf.status = 'CONFIRMED' AND ${inRange("coalesce(rf.decided_at, rf.created_at)")})::bigint AS refunds,
                  (SELECT coalesce(sum(d.gross_kobo), 0) FROM prize_deductions d JOIN cycles c ON c.id = d.cycle_id WHERE c.state_code = $3 AND d.status = 'DEDUCTED' AND ${inRange("d.created_at")})::bigint AS cash_prizes,
                  (SELECT coalesce(sum(d.deduction_kobo), 0) FROM prize_deductions d JOIN cycles c ON c.id = d.cycle_id WHERE c.state_code = $3 AND d.status = 'DEDUCTED' AND ${inRange("d.created_at")})::bigint AS deductions,
                  (SELECT count(*) FROM prize_claims pc JOIN prize_tiers pt ON pt.id = pc.prize_tier_id JOIN cycles c ON c.id = pt.cycle_id
                    WHERE c.state_code = $3 AND pt.kind = 'MERCHANDISE' AND pc.status <> 'VOID' AND ${inRange("pc.created_at")})::int AS merch_prizes,
                  (SELECT count(*) FROM users u WHERE u.state_code = $3 AND u.kyc_tier >= 1 AND ${inRange("u.created_at")})::int AS new_players,
                  (SELECT count(*) FROM self_exclusions e JOIN users u ON u.id = e.user_id WHERE u.state_code = $3 AND ${inRange("e.created_at")})::int AS breaks,
                  (SELECT count(*) FROM support_tickets s JOIN users u ON u.id = s.user_id WHERE u.state_code = $3 AND s.topic = 'COMPLAINT' AND ${inRange("s.created_at")})::int AS complaints,
                  (SELECT count(*) FROM support_tickets s JOIN users u ON u.id = s.user_id WHERE u.state_code = $3 AND s.topic = 'COMPLAINT' AND s.closed_at IS NOT NULL AND ${inRange("s.closed_at")})::int AS complaints_closed`,
          [p.from, p.to, st]))!;
        out.push({ state: st, campaigns: r.campaigns as number, cards_sold: r.cards_sold as number, gross_sales: k(r.gross_sales), refunds: k(x.refunds),
          cash_prizes: k(x.cash_prizes), merch_prizes: Number(x.merch_prizes), deductions: k(x.deductions), new_players: Number(x.new_players),
          active_players: r.active_players as number, breaks: Number(x.breaks), complaints: Number(x.complaints), complaints_closed: Number(x.complaints_closed) });
      }
      return { rows: out, notes: ["The authority's prescribed format and frequency are to be confirmed; this return carries the figures they usually ask for."] };
    },
  },
  {
    id: "security-incidents", title: "Security incidents", frequency: "Immediate", roles: ["COMPLIANCE", "AUDITOR", "SECURITY_ADMIN"], needs: "range",
    description: "Security alerts raised in the period (each is raised the moment it happens): locked staff accounts, handover code guessing, shared bank accounts, payment mismatches, sign-up surges and failed draw checks.",
    columns: [c("raised", "Raised"), c("kind", "Kind"), c("severity", "Severity"), c("about", "About"), c("status", "Status")],
    async run(ctx, p) {
      const rows = (await ctx.pool.query(
        `SELECT to_char(a.created_at AT TIME ZONE '${TZ}', 'YYYY-MM-DD HH24:MI') AS raised, a.kind, a.severity, a.entity_type || ' ' || left(a.entity_id, 8) AS about, a.status
         FROM compliance_alerts a WHERE a.kind = ANY($3) AND ${inRange("a.created_at")} ORDER BY a.created_at DESC`, [p.from, p.to, SECURITY_ALERTS])).rows;
      return { rows };
    },
  },
  {
    id: "campaign-audit", title: "Campaign audit", frequency: "End of cycle", roles: ["AUDITOR", "COMPLIANCE", "FINANCE"], needs: "cycle",
    description: "One campaign from approval to close-out: approvals, the sealed results, sales, reconciliation, the draw and its independent report, prizes and their fulfilment, money and close-out.",
    columns: [c("section", "Section"), c("item", "Item"), c("value", "Value")],
    async run(ctx, p) {
      const cy = await one<Record<string, unknown>>(ctx.pool,
        `SELECT c.*, cc.published_at, encode(cc.ticket_merkle_root, 'hex') AS root, cc.game_core_version AS engine,
                (SELECT string_agg(ap.capacity || ' ' || to_char(ap.approved_at, 'YYYY-MM-DD'), '; ') FROM cycle_approvals ap WHERE ap.cycle_id = c.id) AS approvals,
                encode(dr.sha256, 'hex') AS report_sha, dr.all_checks_pass, dr.attested_at, aa.full_name AS attested_by, d.executed_at, d.entries_count
         FROM cycles c LEFT JOIN cycle_commitments cc ON cc.cycle_id = c.id LEFT JOIN draws d ON d.cycle_id = c.id
         LEFT JOIN draw_reports dr ON dr.cycle_id = c.id LEFT JOIN admin_users aa ON aa.id = dr.attested_by WHERE c.id = $1`, [p.cycleId]);
      if (!cy) throw notFound("Campaign not found.");
      const res = (await cycleResults(ctx, { id: "", email: "", fullName: "", roles: ["AUDITOR"] })).find((r) => r.id === p.cycleId)!;
      const claims = (await one<Record<string, number>>(ctx.pool,
        `SELECT count(*) FILTER (WHERE pt.kind = 'MERCHANDISE')::int AS goods, count(*) FILTER (WHERE pt.kind = 'MERCHANDISE' AND pc.status = 'DELIVERED')::int AS delivered,
                count(*) FILTER (WHERE pt.kind = 'MERCHANDISE' AND pc.status = 'EXPIRED')::int AS expired,
                count(*) FILTER (WHERE pt.kind = 'MERCHANDISE' AND pc.status IN ('ENTITLED','ON_HOLD','VERIFIED','DISPATCHED'))::int AS outstanding
         FROM prize_claims pc JOIN prize_tiers pt ON pt.id = pc.prize_tier_id WHERE pt.cycle_id = $1`, [p.cycleId]))!;
      const recon = (await one<{ days: number; signed: number; mismatched: number }>(ctx.pool,
        `SELECT count(*)::int AS days, count(*) FILTER (WHERE signed_off_by IS NOT NULL)::int AS signed, count(*) FILTER (WHERE status = 'MISMATCH')::int AS mismatched
         FROM reconciliations WHERE day BETWEEN ($1::timestamptz AT TIME ZONE '${TZ}')::date AND ($2::timestamptz AT TIME ZONE '${TZ}')::date`, [cy.sales_open_at, cy.sales_close_at]))!;
      const naira = (v: unknown) => `₦${(k(v) / 100).toLocaleString("en-NG")}`;
      const d = (v: unknown) => (v ? (v as Date).toISOString().slice(0, 16).replace("T", " ") : "—");
      const rows: Row[] = [
        { section: "Campaign", item: "Name and reference", value: `${cy.name} (${cy.id})` },
        { section: "Campaign", item: "Status", value: String(cy.status) },
        { section: "Campaign", item: "Approvals", value: String(cy.approvals ?? "—") },
        { section: "Sealed results", item: "Published", value: d(cy.published_at) },
        { section: "Sealed results", item: "Card fingerprint (Merkle root)", value: String(cy.root ?? "—") },
        { section: "Sealed results", item: "Game engine", value: String(cy.engine ?? "—") },
        { section: "Sales", item: "Cards sold of total", value: `${res.cards_sold} of ${cy.total_tickets}` },
        { section: "Sales", item: "Gross sales / refunds / net revenue", value: `${naira(res.gross_sales_kobo)} / ${naira(res.refunds_kobo)} / ${naira(res.net_revenue_kobo)}` },
        { section: "Reconciliation", item: "Days reconciled / signed off / with differences", value: `${recon.days} / ${recon.signed} / ${recon.mismatched}` },
        { section: "Draw", item: "Executed / entries", value: `${d(cy.executed_at)} / ${cy.entries_count ?? "—"}` },
        { section: "Draw", item: "Independent report", value: cy.report_sha ? `${cy.all_checks_pass ? "all checks passed" : "A CHECK FAILED"} · ${cy.report_sha}` : "Not generated" },
        { section: "Draw", item: "Attested by", value: cy.attested_at ? `${cy.attested_by}, ${d(cy.attested_at)}` : "Not yet" },
        { section: "Prizes", item: "Cash prizes (instant + draw − forfeited)", value: naira(k(res.instant_prizes_kobo) + k(res.draw_cash_prizes_kobo) - k(res.forfeited_prizes_kobo)) },
        { section: "Prizes", item: "Statutory deductions", value: naira(res.statutory_deductions_kobo) },
        { section: "Prizes", item: "Merchandise won / delivered / outstanding / unclaimed", value: `${claims.goods} / ${claims.delivered} / ${claims.outstanding} / ${claims.expired}` },
        { section: "Money", item: "Merchandise at landed cost", value: naira(res.merchandise_cost_kobo) },
        { section: "Money", item: "Referral earnings / operating expenses", value: `${naira(k(res.referral_commissions_kobo) + k(res.affiliate_fees_kobo))} / ${naira(res.operating_expenses_kobo)}` },
        { section: "Money", item: "Contribution / prize payout ratio", value: `${naira(res.contribution_kobo)} / ${res.prize_payout_ratio === null ? "—" : Math.round(res.prize_payout_ratio * 100) + "%"}` },
        { section: "Close-out", item: "Archived", value: d(cy.archived_at) },
      ];
      return { rows };
    },
  },
];

export function reportCatalogue(admin: Admin): unknown {
  return { reports: REPORTS.filter((r) => r.roles.some((x) => admin.roles.includes(x)))
    .map(({ id, title, frequency, description, needs }) => ({ id, title, frequency, description, needs })) };
}

const isDay = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);

export async function runReport(ctx: Ctx, admin: Admin, id: string, p: Params): Promise<{ id: string; title: string; frequency: string; description: string; columns: Column[]; rows: Row[]; notes: string[]; generatedAt: string }> {
  const def = REPORTS.find((r) => r.id === id);
  if (!def) throw notFound("Report not found.");
  requireRole(admin, ...def.roles);
  if (def.needs === "range" && (!isDay(p.from) || !isDay(p.to) || p.from > p.to)) throw badRequest("INVALID_DATE", "Choose a valid date range.");
  if (def.needs === "cycle" && !p.cycleId) throw badRequest("CYCLE_REQUIRED", "Choose the campaign.");
  const out = await def.run(ctx, p);
  return { id: def.id, title: def.title, frequency: def.frequency, description: def.description, columns: def.columns, rows: out.rows, notes: out.notes ?? [], generatedAt: new Date().toISOString() };
}

/** The same report as a spreadsheet: amounts in naira (as numbers), percentages as fractions. */
export function reportCsv(r: Awaited<ReturnType<typeof runReport>>): string {
  return toCsv(r.columns.map((col) => col.kind === "kobo" ? `${col.label} (NGN)` : col.label),
    r.rows.map((row) => r.columns.map((col) => { const v = row[col.key]; return col.kind === "kobo" ? (v === null || v === undefined ? null : Number(v) / 100) : (v as string | number | null); })));
}

/**
 * SRS section 15: the campaign position on the central dashboard — actual
 * figures, with an operating-cost line that is an illustrative assumption
 * (20% of realised revenue by default) beside the operating costs actually recorded.
 */
export async function campaignPosition(ctx: Ctx, cycleId: string): Promise<unknown> {
  const c = await one<{ total_tickets: number; ticket_price_kobo: number; status: string }>(ctx.pool, "SELECT total_tickets, ticket_price_kobo, status FROM cycles WHERE id = $1", [cycleId]);
  if (!c) throw notFound("Campaign not found.");
  const x = (await one<Record<string, string>>(ctx.pool,
    `SELECT (SELECT count(*) FROM tickets WHERE cycle_id = $1 AND status IN ('SOLD','REVEALED'))::int AS sold,
            -coalesce((SELECT balance_kobo FROM ledger_balances WHERE code = 'TICKET_REVENUE:' || $1), 0)::bigint AS realised,
            (SELECT coalesce(sum(CASE WHEN p.kind = 'CASH' THEN p.cash_kobo ELSE k.advertised_value_kobo END * p.quantity), 0)
               FROM prize_tiers p LEFT JOIN skus k ON k.id = p.sku_id WHERE p.cycle_id = $1)::bigint AS commitments,
            (SELECT coalesce(sum(CASE WHEN reverses IS NULL THEN amount_kobo ELSE -amount_kobo END), 0) FROM operating_expenses WHERE cycle_id = $1)::bigint AS recorded_costs,
            coalesce((SELECT sum(balance_kobo) FROM ledger_balances WHERE code IN ('AFFILIATE_EXPENSE:' || $1, 'FULFILMENT_EXPENSE:' || $1, 'REFERRAL_EXPENSE:' || $1)), 0)::bigint AS other_costs`, [cycleId]))!;
  const realised = k(x.realised), maxRevenue = c.total_tickets * k(c.ticket_price_kobo), commitments = k(x.commitments);
  const bp = ctx.config.illustrativeCostBp ?? 2000;
  const illustrative = Math.round((realised * bp) / 10_000);
  return {
    sold: Number(x.sold), remaining: c.total_tickets - Number(x.sold), realisedKobo: realised, maxRevenueKobo: maxRevenue, commitmentsKobo: commitments,
    illustrativeCostPercent: bp / 100, illustrativeCostsKobo: illustrative, recordedCostsKobo: k(x.recorded_costs) + k(x.other_costs),
    indicativeBalanceKobo: realised - commitments - illustrative,
    note: `Operating costs at ${bp / 100}% of realised revenue are an illustrative assumption, as in the SRS; recorded costs are shown beside them.`,
  };
}
