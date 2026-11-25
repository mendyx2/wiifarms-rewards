import { createHash, randomBytes } from "node:crypto";
import { audit } from "../audit.ts";
import type { Ctx } from "../context.ts";
import { lockKey, one, withTx, type Db } from "../db.ts";
import { badRequest, conflict, forbidden, notFound } from "../errors.ts";
import { accounts, post } from "../ledger.ts";
import { adminActor, requireRole, type Admin } from "./admin.ts";
import { MAX_IMAGE, SIGNATURES } from "./promo.ts";

/**
 * Stockist fulfilment (SRS section 14).
 *
 * STK-001/002 authorised centres and their coverage: Fulfilment registers,
 *   Compliance approves (another person), and can suspend.
 * STK-003/004 allocating prize stock: units keep their prize-stock record
 *   (reserved to a cycle); their location moves only with a recorded movement.
 * STK-005/006/007 vouchers: issued when a collection prize is sent to a centre;
 *   the centre verifies the voucher, checks the winner's ID, takes a photo and
 *   enters the one-time code only the winner has. Redeemable once.
 * STK-008 reconciliation per centre; STK-009 approved fees (fee changes need a
 *   second person, in Finance); STK-010 damaged or unavailable stock;
 *   STK-011 invoices; STK-012 outstanding obligations.
 */

export type Tier = "MEGA" | "SUB" | "SPECIALIST";
export const ID_TYPES = ["NIN_SLIP", "VOTERS_CARD", "DRIVERS_LICENCE", "PASSPORT", "OTHER"] as const;
const VIEW = ["FULFILMENT", "COMPLIANCE", "FINANCE", "AUDITOR", "CYCLE_MANAGER"] as const;

function dbRule(err: unknown): never {
  const e = err as { code?: string; message?: string; constraint?: string };
  if (e.code === "23505" && e.constraint === "stock_incidents_one_open") throw conflict("INCIDENT_OPEN", "There is already an open report for this unit.");
  if (e.code === "23505" && e.constraint === "stockist_invoices_one_open") throw conflict("INVOICE_OPEN", "An invoice is already waiting for Finance.");
  if (e.code === "23000" || e.code === "23514") throw conflict("RULE_VIOLATION", e.message ?? "Not allowed.");
  throw err;
}

/** The centre a STOCKIST account works for (staff with other roles have none). */
function myCentre(admin: Admin): string {
  requireRole(admin, "STOCKIST");
  if (!admin.stockistId) throw forbidden("NO_CENTRE", "This account is not linked to a collection centre.");
  return admin.stockistId;
}

// --- Centres (STK-001, STK-002, STK-009) --------------------------------------------------------

export interface NewStockist {
  name: string; tier: Tier; parentId?: string; stateCode: string; area: string; address: string; phone: string;
  coverage: string[]; openingHours?: string; feeKobo: number;
}

export async function registerStockist(ctx: Ctx, admin: Admin, input: NewStockist): Promise<{ id: string; code: string }> {
  requireRole(admin, "FULFILMENT");
  if ((input.tier === "SUB") !== Boolean(input.parentId)) throw badRequest("INVALID_TIER", "A Sub Stockist belongs to a Mega Stockist; other centres have none.");
  if (!input.coverage.length) throw badRequest("COVERAGE_REQUIRED", "List the local government areas the centre serves.");
  return withTx(ctx.pool, async (db) => {
    if (input.parentId && !(await one(db, "SELECT 1 FROM stockists WHERE id = $1 AND tier = 'MEGA' AND status = 'ACTIVE'", [input.parentId]))) {
      throw badRequest("INVALID_PARENT", "Choose an approved Mega Stockist.");
    }
    const code = `STK-${(await one<{ n: string }>(db, "SELECT nextval('stockist_code_seq')::text AS n"))!.n.padStart(4, "0")}`;
    const r = await db.query<{ id: string }>(
      `INSERT INTO stockists (code, name, tier, parent_id, state_code, area, address, phone, coverage, opening_hours, fee_kobo, registered_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
      [code, input.name.trim(), input.tier, input.parentId ?? null, input.stateCode, input.area.trim(), input.address.trim(), input.phone.trim(),
        input.coverage.map((c) => c.trim()).filter(Boolean), input.openingHours?.trim() || null, input.feeKobo, admin.id]).catch(dbRule);
    await audit(db, adminActor(admin), "stockist.registered", "stockist", r.rows[0]!.id, { code, tier: input.tier, feeKobo: input.feeKobo });
    return { id: r.rows[0]!.id, code };
  });
}

export async function decideStockist(ctx: Ctx, admin: Admin, stockistId: string, decision: "APPROVE" | "REJECT" | "SUSPEND" | "REINSTATE", reason?: string): Promise<{ status: string }> {
  requireRole(admin, "COMPLIANCE");
  if (decision !== "APPROVE" && !reason?.trim()) throw badRequest("REASON_REQUIRED", "Give the reason.");
  const moves = { APPROVE: ["PENDING", "ACTIVE"], REJECT: ["PENDING", "REJECTED"], SUSPEND: ["ACTIVE", "SUSPENDED"], REINSTATE: ["SUSPENDED", "ACTIVE"] } as const;
  const [from, to] = moves[decision];
  return withTx(ctx.pool, async (db) => {
    const s = await one<{ status: string; registered_by: string }>(db, "SELECT status, registered_by FROM stockists WHERE id = $1 FOR UPDATE", [stockistId]);
    if (!s) throw notFound("Collection centre not found.");
    if (s.status !== from) throw conflict("INVALID_STATUS", `This centre is ${s.status.toLowerCase()}.`);
    if (decision === "APPROVE" && s.registered_by === admin.id) throw forbidden("SAME_PERSON", "You registered this centre, so someone else must approve it.");
    await db.query(`UPDATE stockists SET status = $2${decision === "APPROVE" ? ", approved_by = $3" : ""} WHERE id = $1`,
      decision === "APPROVE" ? [stockistId, to, admin.id] : [stockistId, to]).catch(dbRule);
    await audit(db, adminActor(admin), `stockist.${to.toLowerCase()}`, "stockist", stockistId, { reason: reason ?? null });
    return { status: to };
  });
}

/** A new fee per handover takes effect only when someone in Finance (another person) approves it. */
export async function requestFeeChange(ctx: Ctx, admin: Admin, stockistId: string, feeKobo: number): Promise<{ status: string }> {
  requireRole(admin, "FULFILMENT");
  return withTx(ctx.pool, async (db) => {
    const r = await db.query("UPDATE stockists SET pending_fee_kobo = $2, fee_requested_by = $3 WHERE id = $1 AND pending_fee_kobo IS NULL", [stockistId, feeKobo, admin.id]);
    if (!r.rowCount) throw conflict("FEE_CHANGE_PENDING", "A fee change is already waiting for approval (or the centre does not exist).");
    await audit(db, adminActor(admin), "stockist.fee_change_requested", "stockist", stockistId, { feeKobo });
    return { status: "PENDING" };
  });
}

export async function decideFeeChange(ctx: Ctx, admin: Admin, stockistId: string, approve: boolean): Promise<{ feeKobo: number }> {
  requireRole(admin, "FINANCE");
  return withTx(ctx.pool, async (db) => {
    const s = await one<{ fee_kobo: number; pending_fee_kobo: number | null; fee_requested_by: string | null }>(db,
      "SELECT fee_kobo, pending_fee_kobo, fee_requested_by FROM stockists WHERE id = $1 FOR UPDATE", [stockistId]);
    if (!s || s.pending_fee_kobo === null) throw conflict("NO_FEE_CHANGE", "There is no fee change waiting.");
    if (s.fee_requested_by === admin.id) throw forbidden("SAME_PERSON", "You asked for this change, so someone else must approve it.");
    const fee = approve ? Number(s.pending_fee_kobo) : Number(s.fee_kobo);
    await db.query("UPDATE stockists SET fee_kobo = $2, pending_fee_kobo = NULL, fee_requested_by = NULL WHERE id = $1", [stockistId, fee]);
    await audit(db, adminActor(admin), approve ? "stockist.fee_changed" : "stockist.fee_change_rejected", "stockist", stockistId, { feeKobo: fee });
    return { feeKobo: fee };
  });
}

export async function listStockists(ctx: Ctx, admin: Admin): Promise<unknown> {
  requireRole(admin, ...VIEW, "SECURITY_ADMIN");
  return { stockists: (await ctx.pool.query(
    `SELECT s.id, s.code, s.name, s.tier, s.parent_id, p.name AS parent_name, s.state_code, s.area, s.address, s.phone, s.coverage, s.opening_hours,
            s.fee_kobo, s.pending_fee_kobo, s.fee_requested_by, s.status, s.registered_by, r.full_name AS registered_by_name, a.full_name AS approved_by_name, s.created_at,
            (SELECT count(*) FROM stock_units u WHERE u.stockist_id = s.id AND u.status IN ('IN_STOCK','RESERVED','ALLOCATED','DISPATCHED'))::int AS units_held
     FROM stockists s LEFT JOIN stockists p ON p.id = s.parent_id JOIN admin_users r ON r.id = s.registered_by LEFT JOIN admin_users a ON a.id = s.approved_by
     ORDER BY (s.status = 'PENDING') DESC, s.tier, s.name`)).rows.map((r) => ({ ...r, fee_kobo: Number(r.fee_kobo), pending_fee_kobo: r.pending_fee_kobo === null ? null : Number(r.pending_fee_kobo) })) };
}

/** The public stockist locator (WEB-009): approved collection centres only. */
export async function publicStockists(ctx: Ctx, stateCode?: string): Promise<unknown> {
  return { centres: (await ctx.pool.query(
    `SELECT id, name, tier, state_code, area, address, phone, coverage, opening_hours FROM stockists
     WHERE status = 'ACTIVE' AND tier <> 'SPECIALIST' AND ($1::text IS NULL OR state_code = $1) ORDER BY area, name`, [stateCode ?? null])).rows };
}

// --- Stock at centres (STK-003, STK-004) ----------------------------------------------------------

/** Moves a unit with a permanent record; the database refuses a move without one. */
export async function moveUnit(db: Db, admin: Admin, unitId: string, toStockistId: string | null, reason: string): Promise<void> {
  const u = await one<{ stockist_id: string | null; status: string }>(db, "SELECT stockist_id, status FROM stock_units WHERE id = $1 FOR NO KEY UPDATE", [unitId]);
  if (!u) throw notFound("Unit not found.");
  if (u.stockist_id === toStockistId) return;
  if (!["IN_STOCK", "RESERVED", "ALLOCATED", "DISPATCHED"].includes(u.status)) throw conflict("NOT_MOVABLE", "A unit that has been handed over or written off cannot be moved.");
  if (toStockistId && !(await one(db, "SELECT 1 FROM stockists WHERE id = $1 AND status = 'ACTIVE'", [toStockistId]))) throw badRequest("INVALID_STOCKIST", "Choose an approved collection centre.");
  if (await one(db, "SELECT 1 FROM stock_incidents WHERE stock_unit_id = $1 AND status = 'OPEN'", [unitId])) throw conflict("INCIDENT_OPEN", "This unit has an open damage or loss report.");
  await db.query("INSERT INTO stock_movements (stock_unit_id, from_stockist, to_stockist, reason, moved_by) VALUES ($1, $2, $3, $4, $5)",
    [unitId, u.stockist_id, toStockistId, reason, admin.id]);
  await db.query("UPDATE stock_units SET stockist_id = $2 WHERE id = $1", [unitId, toStockistId]).catch(dbRule);
}

/** Sends prize stock (still reserved to its cycle) to a centre ahead of claims, or back to the warehouse. */
export async function allocateUnits(ctx: Ctx, admin: Admin, input: { unitIds: string[]; toStockistId: string | null; reason: string }): Promise<{ moved: number }> {
  requireRole(admin, "FULFILMENT");
  if (!input.reason.trim()) throw badRequest("REASON_REQUIRED", "Give the reason for the move.");
  return withTx(ctx.pool, async (db) => {
    for (const id of input.unitIds) await moveUnit(db, admin, id, input.toStockistId, input.reason.trim());
    await audit(db, adminActor(admin), "stock.allocated", "stockist", input.toStockistId ?? "warehouse", { units: input.unitIds.length, reason: input.reason });
    return { moved: input.unitIds.length };
  });
}

/** Units that can be sent to a centre: prize stock not yet handed over. */
export async function movableUnits(ctx: Ctx, admin: Admin): Promise<unknown> {
  requireRole(admin, ...VIEW);
  return { units: (await ctx.pool.query(
    `SELECT u.id, k.name AS item, u.serial_number, u.status, c.name AS cycle, u.stockist_id, s.name AS stockist_name
     FROM stock_units u JOIN skus k ON k.id = u.sku_id LEFT JOIN cycles c ON c.id = u.reserved_cycle_id LEFT JOIN stockists s ON s.id = u.stockist_id
     WHERE u.status IN ('IN_STOCK','RESERVED','ALLOCATED') ORDER BY k.name, u.serial_number NULLS LAST LIMIT 1000`)).rows };
}

/** A fresh voucher reference: easy to read out, impossible to guess usefully (the handover code is still needed). */
export function newVoucherRef(): string {
  const A = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789", b = randomBytes(8);
  let s = "";
  for (let i = 0; i < 8; i++) s += A[b[i]! & 31];
  return `WV-${s.slice(0, 4)}-${s.slice(4)}`;
}

// --- The portal (STOCKIST) ------------------------------------------------------------------------

export async function portalDashboard(ctx: Ctx, admin: Admin): Promise<unknown> {
  const sid = myCentre(admin);
  const centre = await one(ctx.pool, "SELECT id, code, name, tier, state_code, area, address, coverage, fee_kobo, status FROM stockists WHERE id = $1", [sid]);
  const n = (await one<{ assigned: number; fulfilled: number; waiting: number; held: number; incidents: number }>(ctx.pool,
    `SELECT (SELECT count(*) FROM stock_units u WHERE u.stockist_id = $1)::int AS assigned,
            (SELECT count(*) FROM shipments sh WHERE sh.stockist_id = $1 AND sh.status = 'HANDED_OVER')::int AS fulfilled,
            (SELECT count(*) FROM shipments sh WHERE sh.stockist_id = $1 AND sh.status = 'IN_TRANSIT')::int AS waiting,
            (SELECT count(*) FROM stock_units u WHERE u.stockist_id = $1 AND u.status IN ('IN_STOCK','RESERVED','ALLOCATED'))::int AS held,
            (SELECT count(*) FROM stock_incidents i WHERE i.stockist_id = $1 AND i.status = 'OPEN')::int AS incidents`, [sid]))!;
  const pending = (await ctx.pool.query(
    `SELECT sh.voucher_ref, pt.title, sh.dispatched_at, pc.expires_at FROM shipments sh JOIN prize_claims pc ON pc.id = sh.prize_claim_id
     JOIN prize_tiers pt ON pt.id = pc.prize_tier_id WHERE sh.stockist_id = $1 AND sh.status = 'IN_TRANSIT' ORDER BY sh.dispatched_at`, [sid])).rows;
  const units = (await ctx.pool.query(
    `SELECT u.id, k.name AS item, u.serial_number, u.status, (SELECT i.kind FROM stock_incidents i WHERE i.stock_unit_id = u.id AND i.status = 'OPEN') AS incident
     FROM stock_units u JOIN skus k ON k.id = u.sku_id WHERE u.stockist_id = $1 AND u.status <> 'DELIVERED' ORDER BY k.name`, [sid])).rows;
  const fees = (await one<{ unbilled: string; billed: string; paid: string }>(ctx.pool,
    `SELECT coalesce(sum(f.amount_kobo) FILTER (WHERE f.invoice_id IS NULL), 0)::bigint AS unbilled,
            coalesce(sum(f.amount_kobo) FILTER (WHERE i.status = 'SUBMITTED'), 0)::bigint AS billed,
            coalesce(sum(f.amount_kobo) FILTER (WHERE i.status = 'PAID'), 0)::bigint AS paid
     FROM stockist_fees f LEFT JOIN stockist_invoices i ON i.id = f.invoice_id WHERE f.stockist_id = $1`, [sid]))!;
  const invoices = (await ctx.pool.query("SELECT reference, their_reference, amount_kobo, fees_count, status, payment_ref, created_at, decided_at, reason FROM stockist_invoices WHERE stockist_id = $1 ORDER BY created_at DESC LIMIT 24", [sid]))
    .rows.map((r) => ({ ...r, amount_kobo: Number(r.amount_kobo) }));
  const total = n.fulfilled + n.waiting;
  return { centre, stats: { ...n, outstanding: n.waiting, fulfilmentRate: total ? Math.round((n.fulfilled / total) * 1000) / 10 : null },
    pending, units, fees: { unbilledKobo: Number(fees.unbilled), invoicedKobo: Number(fees.billed), paidKobo: Number(fees.paid) }, invoices };
}

/**
 * Verifies a voucher read out or shown by the winner. Says only whether it is
 * valid here; on success, shows what is needed to check the winner's identity.
 */
export async function verifyVoucher(ctx: Ctx, admin: Admin, voucherRef: string): Promise<unknown> {
  const sid = myCentre(admin);
  const ref = voucherRef.trim().toUpperCase();
  const v = await one<{ stockist_id: string; status: string; title: string; full_name: string; phone: string; serial_number: string | null; claim_id: string; incident: boolean; handed_over_at: Date | null }>(ctx.pool,
    `SELECT sh.stockist_id, sh.status, pt.title, u.full_name, right(u.phone_e164, 4) AS phone, su.serial_number, pc.id AS claim_id, sh.handed_over_at,
            EXISTS (SELECT 1 FROM stock_incidents i WHERE i.stock_unit_id = pc.stock_unit_id AND i.status = 'OPEN') AS incident
     FROM shipments sh JOIN prize_claims pc ON pc.id = sh.prize_claim_id JOIN prize_tiers pt ON pt.id = pc.prize_tier_id
     JOIN users u ON u.id = pc.user_id LEFT JOIN stock_units su ON su.id = pc.stock_unit_id WHERE sh.voucher_ref = $1`, [ref]);
  await withTx(ctx.pool, (db) => audit(db, adminActor(admin), "voucher.checked", "stockist", sid, { voucher: ref, found: Boolean(v) }));
  if (!v || v.stockist_id !== sid) throw notFound("This voucher is not valid at this centre.");
  if (v.status === "HANDED_OVER") throw conflict("ALREADY_REDEEMED", `This voucher was already redeemed on ${v.handed_over_at!.toISOString().slice(0, 10)}. Do not hand anything over.`);
  if (v.status !== "IN_TRANSIT") throw conflict("NOT_READY", "This voucher is not ready for collection.");
  return { voucherRef: ref, claimId: v.claim_id, prize: v.title, serialNumber: v.serial_number, winnerName: v.full_name, winnerPhoneLast4: v.phone, incidentOpen: v.incident,
    instructions: "Check the winner's photo ID matches this name. Take a photo of the handover. Ask the winner to read out the code in their app and enter it." };
}

export async function reportIncident(ctx: Ctx, admin: Admin, input: { unitId: string; kind: "DAMAGED" | "MISSING" | "WRONG_ITEM" | "OTHER"; description: string }): Promise<{ id: string }> {
  requireRole(admin, "STOCKIST", "FULFILMENT");
  return withTx(ctx.pool, async (db) => {
    const u = await one<{ stockist_id: string | null; status: string }>(db, "SELECT stockist_id, status FROM stock_units WHERE id = $1", [input.unitId]);
    if (!u || (admin.roles.includes("STOCKIST") && u.stockist_id !== admin.stockistId)) throw notFound("Unit not found at this centre.");
    if (u.status === "DELIVERED") throw conflict("ALREADY_DELIVERED", "This unit has already been handed over.");
    const r = await db.query<{ id: string }>("INSERT INTO stock_incidents (stockist_id, stock_unit_id, kind, description, reported_by) VALUES ($1, $2, $3, $4, $5) RETURNING id",
      [u.stockist_id, input.unitId, input.kind, input.description.trim(), admin.id]).catch(dbRule);
    await db.query("INSERT INTO compliance_alerts (kind, severity, entity_type, entity_id, details) VALUES ('STOCK_INCIDENT', 'WARNING', 'stock_unit', $1, $2)",
      [input.unitId, JSON.stringify({ kind: input.kind, stockistId: u.stockist_id })]);
    await audit(db, adminActor(admin), "stock.incident_reported", "stock_unit", input.unitId, { kind: input.kind });
    return { id: r.rows[0]!.id };
  });
}

/** Fulfilment closes a report (repaired, found, replaced, written off by the usual process…); someone other than the reporter. */
export async function resolveIncident(ctx: Ctx, admin: Admin, incidentId: string, resolution: string): Promise<{ status: string }> {
  requireRole(admin, "FULFILMENT");
  if (!resolution.trim()) throw badRequest("RESOLUTION_REQUIRED", "Record how it was resolved.");
  return withTx(ctx.pool, async (db) => {
    const i = await one<{ status: string; reported_by: string; stock_unit_id: string }>(db, "SELECT status, reported_by, stock_unit_id FROM stock_incidents WHERE id = $1 FOR UPDATE", [incidentId]);
    if (!i) throw notFound("Report not found.");
    if (i.status !== "OPEN") throw conflict("ALREADY_RESOLVED", "This report is already resolved.");
    if (i.reported_by === admin.id) throw forbidden("SAME_PERSON", "You reported this, so someone else must resolve it.");
    await db.query("UPDATE stock_incidents SET status = 'RESOLVED', resolution = $2, resolved_by = $3, resolved_at = now() WHERE id = $1", [incidentId, resolution.trim(), admin.id]).catch(dbRule);
    await audit(db, adminActor(admin), "stock.incident_resolved", "stock_unit", i.stock_unit_id, { resolution });
    return { status: "RESOLVED" };
  });
}

export async function listIncidents(ctx: Ctx, admin: Admin): Promise<unknown> {
  requireRole(admin, ...VIEW);
  return { incidents: (await ctx.pool.query(
    `SELECT i.id, i.kind, i.description, i.status, i.resolution, i.created_at, i.resolved_at, i.reported_by, s.name AS stockist, k.name AS item, u.serial_number,
            r.full_name AS reported_by_name, v.full_name AS resolved_by_name
     FROM stock_incidents i JOIN stock_units u ON u.id = i.stock_unit_id JOIN skus k ON k.id = u.sku_id LEFT JOIN stockists s ON s.id = i.stockist_id
     JOIN admin_users r ON r.id = i.reported_by LEFT JOIN admin_users v ON v.id = i.resolved_by ORDER BY (i.status = 'OPEN') DESC, i.created_at DESC LIMIT 300`)).rows };
}

// --- Fees, invoices (STK-009, STK-011) -------------------------------------------------------------

/** Records the centre's approved fee for a handover, in the handover's transaction. */
export async function accrueHandoverFee(db: Db, shipmentId: string): Promise<void> {
  const s = await one<{ stockist_id: string | null; fee_kobo: number; cycle_id: string }>(db,
    `SELECT sh.stockist_id, st.fee_kobo, pt.cycle_id FROM shipments sh JOIN prize_claims pc ON pc.id = sh.prize_claim_id JOIN prize_tiers pt ON pt.id = pc.prize_tier_id
     LEFT JOIN stockists st ON st.id = sh.stockist_id WHERE sh.id = $1`, [shipmentId]);
  if (!s?.stockist_id || !Number(s.fee_kobo)) return;
  await db.query("INSERT INTO stockist_fees (shipment_id, stockist_id, cycle_id, amount_kobo) VALUES ($1, $2, $3, $4)", [shipmentId, s.stockist_id, s.cycle_id, s.fee_kobo]);
  await post(db, { kind: "STOCKIST_FEE", reference: `shipment:${shipmentId}:fee`, cycleId: s.cycle_id,
    debit: accounts.fulfilmentExpense(s.cycle_id), credit: accounts.stockistPayable(s.stockist_id), amountKobo: Number(s.fee_kobo) });
}

export async function submitInvoice(ctx: Ctx, admin: Admin, theirReference?: string): Promise<{ reference: string; amountKobo: number }> {
  const sid = myCentre(admin);
  return withTx(ctx.pool, async (db) => {
    await lockKey(db, `stockist:${sid}`);
    const due = (await one<{ n: number; amount: string }>(db,
      "SELECT count(*)::int AS n, coalesce(sum(amount_kobo), 0)::bigint AS amount FROM stockist_fees WHERE stockist_id = $1 AND invoice_id IS NULL", [sid]))!;
    if (!due.n) throw conflict("NOTHING_DUE", "There are no fees to invoice yet.");
    const reference = `INV-${(await one<{ n: string }>(db, "SELECT nextval('stockist_invoice_seq')::text AS n"))!.n.padStart(6, "0")}`;
    const r = await db.query<{ id: string }>(
      "INSERT INTO stockist_invoices (stockist_id, reference, their_reference, amount_kobo, fees_count, submitted_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id",
      [sid, reference, theirReference?.trim() || null, due.amount, due.n, admin.id]).catch(dbRule);
    await db.query("UPDATE stockist_fees SET invoice_id = $2 WHERE stockist_id = $1 AND invoice_id IS NULL", [sid, r.rows[0]!.id]);
    await audit(db, adminActor(admin), "stockist.invoice_submitted", "stockist", sid, { reference, amountKobo: Number(due.amount) });
    return { reference, amountKobo: Number(due.amount) };
  });
}

export async function listInvoices(ctx: Ctx, admin: Admin): Promise<unknown> {
  requireRole(admin, "FINANCE", "AUDITOR", "FULFILMENT");
  return { invoices: (await ctx.pool.query(
    `SELECT i.id, i.reference, i.their_reference, i.amount_kobo, i.fees_count, i.status, i.payment_ref, i.reason, i.created_at, i.decided_at, s.name AS stockist, s.code AS stockist_code
     FROM stockist_invoices i JOIN stockists s ON s.id = i.stockist_id ORDER BY (i.status = 'SUBMITTED') DESC, i.created_at DESC LIMIT 300`)).rows
    .map((r) => ({ ...r, amount_kobo: Number(r.amount_kobo) })) };
}

export async function decideInvoice(ctx: Ctx, admin: Admin, invoiceId: string, approve: boolean, reason?: string): Promise<{ status: string; paymentRef?: string }> {
  requireRole(admin, "FINANCE");
  return withTx(ctx.pool, async (db) => {
    const i = await one<{ id: string; stockist_id: string; amount_kobo: number; status: string; reference: string }>(db,
      "SELECT id, stockist_id, amount_kobo, status, reference FROM stockist_invoices WHERE id = $1 FOR UPDATE", [invoiceId]);
    if (!i) throw notFound("Invoice not found.");
    if (i.status !== "SUBMITTED") throw conflict("ALREADY_DECIDED", "This invoice has already been decided.");
    if (!approve) {
      if (!reason?.trim()) throw badRequest("REASON_REQUIRED", "Give the reason for rejecting the invoice.");
      await db.query("UPDATE stockist_fees SET invoice_id = NULL WHERE invoice_id = $1", [i.id]);
      await db.query("UPDATE stockist_invoices SET status = 'REJECTED', decided_by = $2, decided_at = now(), reason = $3 WHERE id = $1", [i.id, admin.id, reason.trim()]).catch(dbRule);
      await audit(db, adminActor(admin), "stockist.invoice_rejected", "stockist", i.stockist_id, { reference: i.reference, reason });
      return { status: "REJECTED" };
    }
    // Simulated: in production a transfer to the centre's account through the payout provider.
    const paymentRef = `SIMSTK-${i.id.slice(0, 8)}`;
    await post(db, { kind: "STOCKIST_SETTLEMENT", reference: `stockist-invoice:${i.id}`, memo: `Invoice ${i.reference}`,
      debit: accounts.stockistPayable(i.stockist_id), credit: accounts.companyBank(), amountKobo: Number(i.amount_kobo) });
    await db.query("UPDATE stockist_invoices SET status = 'PAID', decided_by = $2, decided_at = now(), payment_ref = $3 WHERE id = $1", [i.id, admin.id, paymentRef]).catch(dbRule);
    await audit(db, adminActor(admin), "stockist.invoice_paid", "stockist", i.stockist_id, { reference: i.reference, paymentRef });
    return { status: "PAID", paymentRef };
  });
}

// --- Reports (STK-008, STK-012) --------------------------------------------------------------------

/**
 * Per centre: what it holds now, what it has handed over, vouchers waiting,
 * open incidents and fees — and any unit whose record does not add up.
 */
export async function reconciliation(ctx: Ctx, admin: Admin): Promise<unknown> {
  requireRole(admin, ...VIEW);
  const rows = (await ctx.pool.query(
    `SELECT s.id, s.code, s.name, s.status,
            (SELECT count(*) FROM stock_units u WHERE u.stockist_id = s.id AND u.status IN ('IN_STOCK','RESERVED','ALLOCATED'))::int AS on_shelf,
            (SELECT count(*) FROM stock_units u WHERE u.stockist_id = s.id AND u.status = 'DISPATCHED')::int AS awaiting_collection,
            (SELECT count(*) FROM shipments sh WHERE sh.stockist_id = s.id AND sh.status = 'HANDED_OVER')::int AS handed_over,
            (SELECT count(*) FROM stock_incidents i WHERE i.stockist_id = s.id AND i.status = 'OPEN')::int AS open_incidents,
            (SELECT coalesce(sum(f.amount_kobo), 0) FROM stockist_fees f WHERE f.stockist_id = s.id)::bigint AS fees_kobo,
            -- A unit marked delivered at this centre must have a recorded handover here, and a voucher waiting must have its unit here.
            (SELECT count(*) FROM stock_units u WHERE u.stockist_id = s.id AND u.status = 'DELIVERED'
               AND NOT EXISTS (SELECT 1 FROM prize_claims pc JOIN shipments sh ON sh.prize_claim_id = pc.id WHERE pc.stock_unit_id = u.id AND sh.status = 'HANDED_OVER' AND sh.stockist_id = s.id))::int
          + (SELECT count(*) FROM shipments sh JOIN prize_claims pc ON pc.id = sh.prize_claim_id JOIN stock_units u ON u.id = pc.stock_unit_id
               WHERE sh.stockist_id = s.id AND sh.status = 'IN_TRANSIT' AND u.stockist_id IS DISTINCT FROM s.id)::int AS mismatches
     FROM stockists s WHERE s.status <> 'REJECTED' ORDER BY s.name`)).rows.map((r) => ({ ...r, fees_kobo: Number(r.fees_kobo) }));
  return { centres: rows, totalMismatches: rows.reduce((t, r) => t + r.mismatches, 0) };
}

/** Prizes still owed to winners (STK-012): by stage of fulfilment, with how long they have waited. */
export async function outstandingObligations(ctx: Ctx, admin: Admin): Promise<unknown> {
  requireRole(admin, ...VIEW);
  const byStatus = (await ctx.pool.query(
    `SELECT pc.status, count(*)::int AS prizes, coalesce(sum(k.advertised_value_kobo), 0)::bigint AS value_kobo,
            count(*) FILTER (WHERE pc.created_at < now() - interval '14 days')::int AS older_than_14_days,
            count(*) FILTER (WHERE pc.expires_at < now() + interval '7 days')::int AS expiring_within_7_days
     FROM prize_claims pc JOIN prize_tiers pt ON pt.id = pc.prize_tier_id LEFT JOIN skus k ON k.id = pt.sku_id
     WHERE pt.kind = 'MERCHANDISE' AND pc.status IN ('ENTITLED','ON_HOLD','VERIFIED','DISPATCHED')
     GROUP BY pc.status ORDER BY array_position(ARRAY['ENTITLED','ON_HOLD','VERIFIED','DISPATCHED'], pc.status)`)).rows.map((r) => ({ ...r, value_kobo: Number(r.value_kobo) }));
  const byCentre = (await ctx.pool.query(
    `SELECT s.name, count(*)::int AS waiting, min(sh.dispatched_at) AS oldest
     FROM shipments sh JOIN stockists s ON s.id = sh.stockist_id WHERE sh.status = 'IN_TRANSIT' GROUP BY s.name ORDER BY count(*) DESC`)).rows;
  return { byStatus, byCentre };
}

export async function handoverProof(ctx: Ctx, admin: Admin, claimId: string): Promise<{ bytes: Buffer; type: string }> {
  requireRole(admin, "FULFILMENT", "COMPLIANCE", "AUDITOR");
  const p = await one<{ image: Buffer; content_type: string }>(ctx.pool,
    "SELECT hp.image, hp.content_type FROM handover_proofs hp JOIN shipments sh ON sh.id = hp.shipment_id WHERE sh.prize_claim_id = $1", [claimId]);
  if (!p) throw notFound("No photo recorded.");
  return { bytes: p.image, type: p.content_type };
}

/** Checks and stores the handover photo, in the handover's transaction. */
export async function storeProof(db: Db, admin: Admin, shipmentId: string, photoBase64: string): Promise<string> {
  const bytes = Buffer.from(photoBase64, "base64");
  if (!bytes.length || bytes.length > MAX_IMAGE) throw badRequest("INVALID_IMAGE", "The photo must be at most 1 MB.");
  const type = SIGNATURES.find(([, ok]) => ok(bytes))?.[0];
  if (!type) throw badRequest("INVALID_IMAGE", "Use a PNG, JPEG or WebP photo.");
  const sha = createHash("sha256").update(bytes).digest();
  const r = await db.query<{ id: string }>("INSERT INTO handover_proofs (shipment_id, image, content_type, sha256, recorded_by) VALUES ($1, $2, $3, $4, $5) RETURNING id",
    [shipmentId, bytes, type, sha, admin.id]);
  return `proof:${r.rows[0]!.id}:${sha.toString("hex").slice(0, 16)}`;
}
