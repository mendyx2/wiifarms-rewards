import { randomInt, timingSafeEqual } from "node:crypto";
import { notify } from "./notify.ts";
import { SYSTEM, audit, type Actor } from "../audit.ts";
import type { Ctx } from "../context.ts";
import { keyedHash } from "../crypto.ts";
import { one, withTx, type Db } from "../db.ts";
import { AppError, badRequest, conflict, forbidden, notFound } from "../errors.ts";
import { adminActor, requireRole, type Admin } from "./admin.ts";
import { onExclusionRegister, type User } from "./identity.ts";

const VIEW: Parameters<typeof requireRole>[1][] = ["FULFILMENT", "CYCLE_MANAGER", "FINANCE", "COMPLIANCE", "AUDITOR"];
const HANDOVER_MAX_ATTEMPTS = 5;

function dbRule(err: unknown): never {
  const e = err as { code?: string; message?: string };
  if (e.code === "23000") throw conflict("RULE_VIOLATION", e.message ?? "Not allowed.");
  if (e.code === "23505") throw conflict("ALREADY_EXISTS", "That already exists (for example a serial number or reference that is already recorded).");
  if (e.code === "23514") throw conflict("RULE_VIOLATION", "One of the values is outside what the rules allow.");
  throw err;
}

// --- Reference data ---------------------------------------------------------------------

export async function createSupplier(ctx: Ctx, admin: Admin, input: { name: string; country?: string; contact?: string }): Promise<{ id: string }> {
  requireRole(admin, "FULFILMENT");
  return withTx(ctx.pool, async (db) => {
    const r = await db.query<{ id: string }>("INSERT INTO suppliers (name, country, contact) VALUES ($1, $2, $3) RETURNING id",
      [input.name, input.country ?? null, input.contact ? JSON.stringify({ note: input.contact }) : null]);
    await audit(db, adminActor(admin), "inventory.supplier_created", "supplier", r.rows[0]!.id, { name: input.name });
    return { id: r.rows[0]!.id };
  });
}

export async function createWarehouse(ctx: Ctx, admin: Admin, input: { name: string; address: string; stateCode: string }): Promise<{ id: string }> {
  requireRole(admin, "FULFILMENT");
  return withTx(ctx.pool, async (db) => {
    const r = await db.query<{ id: string }>("INSERT INTO warehouses (name, address, state_code) VALUES ($1, $2, $3) RETURNING id", [input.name, input.address, input.stateCode]);
    await audit(db, adminActor(admin), "inventory.warehouse_created", "warehouse", r.rows[0]!.id, { name: input.name });
    return { id: r.rows[0]!.id };
  });
}

export interface NewItem { name: string; advertisedValueKobo: number; description?: string; serialised?: boolean; warrantyMonths?: number }

export async function createItem(ctx: Ctx, admin: Admin, input: NewItem): Promise<{ id: string }> {
  requireRole(admin, "FULFILMENT", "CYCLE_MANAGER");
  return withTx(ctx.pool, async (db) => {
    const r = await db.query<{ id: string }>(
      "INSERT INTO skus (name, advertised_value_kobo, description, serialised, warranty_months) VALUES ($1, $2, $3, $4, $5) RETURNING id",
      [input.name, input.advertisedValueKobo, input.description ?? null, input.serialised ?? false, input.warrantyMonths ?? null]);
    await audit(db, adminActor(admin), "inventory.sku_created", "sku", r.rows[0]!.id, { ...input });
    return { id: r.rows[0]!.id };
  });
}

// --- Receiving stock -------------------------------------------------------------------------

export interface Receipt {
  skuId: string; supplierId: string; warehouseId: string; poReference: string; documentRef?: string;
  /** Either a quantity, or one serial number per unit for serialised items. */
  quantity?: number; serialNumbers?: string[];
  acquisitionCostKobo: number; landedCostKobo: number;
}

/** Records units physically received into a warehouse against a purchase order, each with its cost. */
export async function receiveStock(ctx: Ctx, admin: Admin, input: Receipt): Promise<{ received: number }> {
  requireRole(admin, "FULFILMENT");
  const serials = (input.serialNumbers ?? []).map((s) => s.trim()).filter(Boolean);
  if (new Set(serials).size !== serials.length) throw badRequest("DUPLICATE_SERIAL", "The same serial number appears twice.");
  const count = serials.length || input.quantity || 0;
  if (!Number.isInteger(count) || count < 1 || count > 5000) throw badRequest("INVALID_QUANTITY", "Enter a quantity between 1 and 5,000, or the serial numbers.");
  if (input.landedCostKobo < input.acquisitionCostKobo) throw badRequest("INVALID_COST", "Landed cost cannot be less than the purchase cost.");
  return withTx(ctx.pool, async (db) => {
    const sku = await one<{ serialised: boolean }>(db, "SELECT serialised FROM skus WHERE id = $1", [input.skuId]);
    if (!sku) throw notFound("Item not found.");
    if (sku.serialised && serials.length === 0) throw badRequest("SERIALS_REQUIRED", "This item is tracked by serial number: enter one serial number per unit.");
    const po = await db.query<{ id: string }>(
      `INSERT INTO purchase_orders (supplier_id, reference, ordered_at, received_at, document_ref) VALUES ($1, $2, current_date, current_date, $3)
       ON CONFLICT (reference) DO UPDATE SET received_at = current_date RETURNING id`,
      [input.supplierId, input.poReference, input.documentRef ?? null]).catch(dbRule);
    await db.query(
      `INSERT INTO stock_units (sku_id, purchase_order_id, warehouse_id, serial_number, acquisition_cost_kobo, landed_cost_kobo, status, received_at)
       SELECT $1, $2, $3, s, $4, $5, 'IN_STOCK', now() FROM unnest($6::text[]) AS s`,
      [input.skuId, po.rows[0]!.id, input.warehouseId, input.acquisitionCostKobo, input.landedCostKobo,
        serials.length ? serials : Array.from({ length: count }, () => null)]).catch(dbRule);
    await audit(db, adminActor(admin), "inventory.stock_received", "sku", input.skuId,
      { units: count, poReference: input.poReference, warehouseId: input.warehouseId, landedCostKobo: input.landedCostKobo });
    return { received: count };
  });
}

// --- Reserving stock to a cycle ------------------------------------------------------------------

export interface TierCover { skuId: string; item: string; needed: number; reserved: number; inStock: number }

export async function stockCover(ctx: Ctx, cycleId: string): Promise<TierCover[]> {
  const r = await ctx.pool.query<{ sku_id: string; name: string; needed: number; reserved: number; in_stock: number }>(
    `SELECT need.sku_id, s.name, need.qty::int AS needed,
            (SELECT count(*) FROM stock_units u WHERE u.sku_id = need.sku_id AND u.reserved_cycle_id = $1)::int AS reserved,
            (SELECT count(*) FROM stock_units u WHERE u.sku_id = need.sku_id AND u.status = 'IN_STOCK')::int AS in_stock
     FROM (SELECT sku_id, sum(quantity) AS qty FROM prize_tiers WHERE cycle_id = $1 AND kind = 'MERCHANDISE' GROUP BY sku_id) need
     JOIN skus s ON s.id = need.sku_id ORDER BY s.name`, [cycleId]);
  return r.rows.map((x) => ({ skuId: x.sku_id, item: x.name, needed: x.needed, reserved: x.reserved, inStock: x.in_stock }));
}

/**
 * Sets aside warehouse stock for every merchandise prize in a cycle. Done by
 * Fulfilment — not by the people who draft or approve the cycle. The database
 * refuses approval until every prize is covered, and refuses to release a
 * reserved unit once the cycle is live.
 */
export async function reserveStock(ctx: Ctx, admin: Admin, cycleId: string): Promise<{ cover: TierCover[]; complete: boolean }> {
  requireRole(admin, "FULFILMENT");
  await withTx(ctx.pool, async (db) => {
    const cycle = await one<{ status: string }>(db, "SELECT status FROM cycles WHERE id = $1 FOR NO KEY UPDATE", [cycleId]);
    if (!cycle) throw notFound("Cycle not found.");
    if (!["DRAFT", "SUBMITTED"].includes(cycle.status)) throw conflict("CYCLE_LOCKED", "Stock can only be reserved before the cycle is approved.");
    const need = await db.query<{ sku_id: string; short: number }>(
      `SELECT need.sku_id, (need.qty - (SELECT count(*) FROM stock_units u WHERE u.sku_id = need.sku_id AND u.reserved_cycle_id = $1))::int AS short
       FROM (SELECT sku_id, sum(quantity) AS qty FROM prize_tiers WHERE cycle_id = $1 AND kind = 'MERCHANDISE' GROUP BY sku_id) need`, [cycleId]);
    let total = 0;
    for (const n of need.rows) {
      if (n.short <= 0) continue;
      // Oldest stock first; SKIP LOCKED so two reservations never take the same unit.
      const r = await db.query(
        `UPDATE stock_units SET status = 'RESERVED', reserved_cycle_id = $1
         WHERE id IN (SELECT id FROM stock_units WHERE sku_id = $2 AND status = 'IN_STOCK' ORDER BY received_at, id LIMIT $3 FOR NO KEY UPDATE SKIP LOCKED)`,
        [cycleId, n.sku_id, n.short]).catch(dbRule);
      total += r.rowCount ?? 0;
    }
    await audit(db, adminActor(admin), "inventory.stock_reserved", "cycle", cycleId, { units: total });
  });
  const cover = await stockCover(ctx, cycleId);
  return { cover, complete: cover.every((c) => c.reserved >= c.needed) };
}

export async function inventoryOverview(ctx: Ctx, admin: Admin): Promise<unknown> {
  requireRole(admin, ...VIEW);
  const q = (sql: string) => ctx.pool.query(sql).then((r) => r.rows);
  const [items, suppliers, warehouses, units] = await Promise.all([
    q(`SELECT s.id, s.name, s.advertised_value_kobo, s.serialised, s.warranty_months,
              count(u.id) FILTER (WHERE u.status = 'IN_STOCK')::int AS in_stock,
              count(u.id) FILTER (WHERE u.status = 'RESERVED')::int AS reserved,
              count(u.id) FILTER (WHERE u.status IN ('ALLOCATED','DISPATCHED'))::int AS with_winners,
              count(u.id) FILTER (WHERE u.status = 'DELIVERED')::int AS delivered,
              coalesce(round(avg(u.landed_cost_kobo)), 0)::bigint AS avg_landed_cost_kobo,
              coalesce(sum(u.landed_cost_kobo) FILTER (WHERE u.status NOT IN ('DELIVERED','WRITTEN_OFF')), 0)::bigint AS stock_value_kobo
       FROM skus s LEFT JOIN stock_units u ON u.sku_id = s.id GROUP BY s.id ORDER BY s.name`),
    q("SELECT id, name, country FROM suppliers ORDER BY name"),
    q("SELECT id, name, address, state_code FROM warehouses ORDER BY name"),
    q(`SELECT u.id, s.name AS item, u.serial_number, u.status, w.name AS warehouse, sp.name AS supplier, po.reference AS po_reference,
              u.acquisition_cost_kobo, u.landed_cost_kobo, c.name AS cycle, u.received_at
       FROM stock_units u JOIN skus s ON s.id = u.sku_id LEFT JOIN warehouses w ON w.id = u.warehouse_id
       LEFT JOIN purchase_orders po ON po.id = u.purchase_order_id LEFT JOIN suppliers sp ON sp.id = po.supplier_id
       LEFT JOIN cycles c ON c.id = u.reserved_cycle_id ORDER BY u.created_at DESC LIMIT 200`),
  ]);
  return { items, suppliers, warehouses, units };
}

// --- Claiming a merchandise prize (player) ------------------------------------------------------------

const CLAIM_SELECT = `
  SELECT pc.id, pc.status, pc.stage, pc.expires_at, pc.created_at, pc.hold_reason, pt.title, pt.kind, pt.cash_kobo, c.name AS cycle, t.serial AS ticket,
         sh.method, sh.status AS shipment_status, sh.carrier, sh.tracking_ref, sh.address, sh.handed_over_at, sh.handover_otp_enc, sh.id AS shipment_id,
         u.serial_number, s.warranty_months
  FROM prize_claims pc JOIN prize_tiers pt ON pt.id = pc.prize_tier_id JOIN cycles c ON c.id = pt.cycle_id JOIN tickets t ON t.id = pc.ticket_id
  LEFT JOIN shipments sh ON sh.prize_claim_id = pc.id LEFT JOIN stock_units u ON u.id = pc.stock_unit_id LEFT JOIN skus s ON s.id = pt.sku_id`;

export async function listClaims(ctx: Ctx, userId: string): Promise<unknown[]> {
  const r = await ctx.pool.query(`${CLAIM_SELECT} WHERE pc.user_id = $1 AND pt.kind = 'MERCHANDISE' ORDER BY pc.created_at DESC`, [userId]);
  return Promise.all(r.rows.map(async (row) => {
    const { handover_otp_enc, shipment_id, ...rest } = row;
    // The winner sees their handover code only while the prize is on its way.
    const code = handover_otp_enc && row.shipment_status === "IN_TRANSIT"
      ? (await ctx.keys.unwrap(handover_otp_enc, `handover:${shipment_id}`)).toString() : null;
    return { ...rest, handoverCode: code };
  }));
}

/**
 * The winner asks for their prize. The caller has already re-confirmed the PIN.
 * Requires verified identity and a next of kin on file; a match on the staff
 * register puts the claim on hold for Compliance instead of proceeding.
 */
export async function redeemClaim(ctx: Ctx, actor: Actor, user: User, claimId: string, input: { method: "DELIVERY" | "COLLECTION"; address?: string }): Promise<{ status: string }> {
  if (input.method === "DELIVERY" && !input.address?.trim()) throw badRequest("ADDRESS_REQUIRED", "Enter the delivery address.");
  return withTx(ctx.pool, async (db) => {
    const claim = await one<{ id: string; status: string; expires_at: Date; cycle_id: string; sku_id: string | null; kind: string }>(
      db,
      `SELECT pc.id, pc.status, pc.expires_at, pt.cycle_id, pt.sku_id, pt.kind FROM prize_claims pc JOIN prize_tiers pt ON pt.id = pc.prize_tier_id
       WHERE pc.id = $1 AND pc.user_id = $2 FOR NO KEY UPDATE OF pc`, [claimId, user.id]);
    if (!claim || claim.kind !== "MERCHANDISE") throw notFound("Prize not found.");
    if (claim.status !== "ENTITLED") throw conflict("ALREADY_CLAIMED", "This prize has already been claimed or is no longer available.");
    if (claim.expires_at.getTime() < Date.now()) throw conflict("CLAIM_EXPIRED", "The claim period for this prize has ended.");
    if (user.kyc_tier < 1) throw forbidden("VERIFICATION_REQUIRED", "Verify your identity before claiming a prize.");
    if (!(await one(db, "SELECT 1 FROM next_of_kin WHERE user_id = $1", [user.id]))) {
      throw forbidden("NEXT_OF_KIN_REQUIRED", "Add your next of kin before claiming this prize.");
    }
    if (await onExclusionRegister(db, user)) {
      await db.query("UPDATE prize_claims SET status = 'ON_HOLD', hold_reason = 'Exclusion register match' WHERE id = $1", [claim.id]);
      await db.query("INSERT INTO compliance_alerts (kind, severity, entity_type, entity_id, details) VALUES ('EXCLUDED_PERSON_PRIZE', 'CRITICAL', 'user', $1, $2)",
        [user.id, JSON.stringify({ claimId: claim.id })]);
      await audit(db, actor, "claim.on_hold", "prize_claim", claim.id, { reason: "exclusion register" });
      return { status: "ON_HOLD" };
    }
    const unit = await one<{ id: string }>(
      db, `SELECT id FROM stock_units WHERE sku_id = $1 AND reserved_cycle_id = $2 AND status = 'RESERVED' ORDER BY received_at, id LIMIT 1 FOR NO KEY UPDATE SKIP LOCKED`,
      [claim.sku_id, claim.cycle_id]);
    if (!unit) throw new AppError(500, "STOCK_MISSING", "We could not allocate your prize automatically. Our team has been alerted and will contact you.");
    await db.query("UPDATE stock_units SET status = 'ALLOCATED' WHERE id = $1", [unit.id]);
    await db.query("UPDATE prize_claims SET status = 'VERIFIED', stock_unit_id = $2 WHERE id = $1", [claim.id, unit.id]);
    await db.query("INSERT INTO shipments (prize_claim_id, method, address) VALUES ($1, $2, $3)", [claim.id, input.method, input.method === "DELIVERY" ? input.address!.trim() : null]);
    await audit(db, actor, "claim.redeemed", "prize_claim", claim.id, { method: input.method, stockUnitId: unit.id });
    return { status: "VERIFIED" };
  });
}

// --- Fulfilment (admin) ----------------------------------------------------------------------------------

export async function fulfilmentQueue(ctx: Ctx, admin: Admin): Promise<unknown[]> {
  requireRole(admin, ...VIEW);
  const r = await ctx.pool.query(
    `${CLAIM_SELECT} JOIN users pl ON pl.id = pc.user_id WHERE pt.kind = 'MERCHANDISE' ORDER BY (pc.status IN ('DELIVERED','EXPIRED','VOID')), pc.created_at`
      .replace("SELECT pc.id,", "SELECT right(pl.phone_e164, 4) AS winner_phone_last4, pl.full_name AS winner_name, pc.id,"));
  // Never send the handover code (or its encrypted form) to staff: only the winner has it.
  return r.rows.map(({ handover_otp_enc: _enc, shipment_id: _sid, ...rest }) => rest);
}

/** Marks a claimed prize as sent out (or ready to collect) and issues the winner's one-time handover code. */
export async function dispatchClaim(ctx: Ctx, admin: Admin, claimId: string, input: { carrier?: string; trackingRef?: string }): Promise<{ status: string }> {
  requireRole(admin, "FULFILMENT");
  return withTx(ctx.pool, async (db) => {
    const row = await one<{ status: string; stock_unit_id: string; shipment_id: string; method: string }>(
      db, `SELECT pc.status, pc.stock_unit_id, sh.id AS shipment_id, sh.method FROM prize_claims pc JOIN shipments sh ON sh.prize_claim_id = pc.id
           WHERE pc.id = $1 FOR NO KEY UPDATE OF pc`, [claimId]);
    if (!row) throw notFound("Claim not found.");
    if (row.status !== "VERIFIED") throw conflict("NOT_READY", "Only a claimed, verified prize can be dispatched.");
    if (row.method === "DELIVERY" && !input.carrier?.trim()) throw badRequest("CARRIER_REQUIRED", "Enter the carrier for a delivery.");
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    await db.query(
      `UPDATE shipments SET status = 'IN_TRANSIT', carrier = $2, tracking_ref = $3, handover_otp_hash = $4, handover_otp_enc = $5,
                            handover_attempts = 0, dispatched_at = now(), dispatched_by = $6 WHERE id = $1`,
      [row.shipment_id, input.carrier ?? null, input.trackingRef ?? null,
        keyedHash(ctx.config.hashKey, "handover", `${row.shipment_id}:${code}`).toString("hex"),
        await ctx.keys.wrap(Buffer.from(code), `handover:${row.shipment_id}`), admin.id]);
    await db.query("UPDATE stock_units SET status = 'DISPATCHED' WHERE id = $1", [row.stock_unit_id]).catch(dbRule);
    await db.query("UPDATE prize_claims SET status = 'DISPATCHED' WHERE id = $1", [claimId]);
    await audit(db, adminActor(admin), "claim.dispatched", "prize_claim", claimId, { carrier: input.carrier ?? null, method: row.method });
    const who = (await one<{ user_id: string; title: string }>(db, "SELECT pc.user_id, pt.title FROM prize_claims pc JOIN prize_tiers pt ON pt.id = pc.prize_tier_id WHERE pc.id = $1", [claimId]))!;
    // The handover code is shown only in the app, never in a text message.
    await notify(db, { userId: who.user_id, kind: "PRIZE_DISPATCHED", urgent: true, link: "#/wallet", dedupeKey: `claim:${claimId}:dispatched`,
      title: row.method === "DELIVERY" ? `Your ${who.title} is on its way` : `Your ${who.title} is ready to collect`,
      body: "Your handover code is in the app. Give it only when the prize is in your hands.",
      sms: `Your ${who.title} is ${row.method === "DELIVERY" ? "on its way" : "ready to collect"}. Your handover code is in the app: give it only when the prize is in your hands.` });
    return { status: "DISPATCHED" };
  });
}

/**
 * Completes the handover. The person handing over must enter the code that
 * only the winner was given, and attach a photo; after five wrong codes the
 * handover is locked for Compliance to review.
 */
export async function confirmHandover(ctx: Ctx, admin: Admin, claimId: string, input: { code: string; photoRef: string; warrantyDocumentRef?: string }): Promise<{ status: string }> {
  requireRole(admin, "FULFILMENT");
  const row = await one<{ shipment_id: string; handover_otp_hash: string | null; handover_attempts: number; shipment_status: string }>(
    ctx.pool, "SELECT id AS shipment_id, handover_otp_hash, handover_attempts, status AS shipment_status FROM shipments WHERE prize_claim_id = $1", [claimId]);
  if (!row) throw notFound("Claim not found.");
  if (row.shipment_status !== "IN_TRANSIT" || !row.handover_otp_hash) throw conflict("NOT_IN_TRANSIT", "This prize is not out for delivery or collection.");
  // Count the attempt first, committed on its own, so guesses are limited.
  const counted = await one<{ handover_attempts: number }>(
    ctx.pool, "UPDATE shipments SET handover_attempts = handover_attempts + 1 WHERE id = $1 AND handover_attempts < $2 RETURNING handover_attempts", [row.shipment_id, HANDOVER_MAX_ATTEMPTS]);
  if (!counted) throw new AppError(429, "HANDOVER_LOCKED", "Too many wrong codes. This handover is locked; Compliance must review it.");
  const given = Buffer.from(keyedHash(ctx.config.hashKey, "handover", `${row.shipment_id}:${input.code}`).toString("hex"));
  if (!timingSafeEqual(given, Buffer.from(row.handover_otp_hash))) {
    if (counted.handover_attempts >= HANDOVER_MAX_ATTEMPTS) {
      await withTx(ctx.pool, async (db) => {
        await db.query("INSERT INTO compliance_alerts (kind, severity, entity_type, entity_id, details) VALUES ('HANDOVER_CODE_FAILURES', 'CRITICAL', 'prize_claim', $1, '{}')", [claimId]);
        await audit(db, SYSTEM, "claim.handover_locked", "prize_claim", claimId);
      });
    }
    throw forbidden("WRONG_CODE", "That code is not correct. Ask the winner to read out the code shown in their app.");
  }
  return withTx(ctx.pool, async (db) => {
    const claim = await one<{ status: string; stock_unit_id: string }>(db, "SELECT status, stock_unit_id FROM prize_claims WHERE id = $1 FOR NO KEY UPDATE", [claimId]);
    if (!claim || claim.status !== "DISPATCHED") throw conflict("NOT_IN_TRANSIT", "This prize is not out for delivery or collection.");
    await db.query(
      `UPDATE shipments SET status = 'HANDED_OVER', handed_over_at = now(), handover_photo_ref = $2, warranty_document_ref = $3,
                            handed_over_by = $4, handover_otp_enc = NULL WHERE id = $1`,
      [row.shipment_id, input.photoRef, input.warrantyDocumentRef ?? null, admin.id]).catch(dbRule);
    await db.query("UPDATE stock_units SET status = 'DELIVERED' WHERE id = $1", [claim.stock_unit_id]).catch(dbRule);
    await db.query("UPDATE prize_claims SET status = 'DELIVERED' WHERE id = $1", [claimId]);
    await audit(db, adminActor(admin), "claim.handed_over", "prize_claim", claimId, { photoRef: input.photoRef });
    const who = (await one<{ user_id: string; title: string }>(db, "SELECT pc.user_id, pt.title FROM prize_claims pc JOIN prize_tiers pt ON pt.id = pc.prize_tier_id WHERE pc.id = $1", [claimId]))!;
    await notify(db, { userId: who.user_id, kind: "PRIZE_DELIVERED", link: "#/wallet", dedupeKey: `claim:${claimId}:delivered`,
      title: `${who.title} received`, body: "Your prize has been handed over and recorded. Enjoy it!" });
    return { status: "DELIVERED" };
  });
}

export async function notifyExpired(db: Db, c: { id: string; user_id: string; prize_tier_id: string }): Promise<void> {
  const title = (await one<{ title: string }>(db, "SELECT title FROM prize_tiers WHERE id = $1", [c.prize_tier_id]))!.title;
  await notify(db, { userId: c.user_id, kind: "CLAIM_EXPIRED", link: "#/wallet", dedupeKey: `claim:${c.id}:expired`,
    title: "Claim period ended", body: `The claim period for your ${title} has ended, so it is no longer available, as the published rules say.` });
}

/** Run periodically: closes claims whose published claim window has ended without the winner coming forward. */
export async function expireClaims(ctx: Ctx): Promise<number> {
  return withTx(ctx.pool, async (db) => {
    const r = await db.query<{ id: string; user_id: string; prize_tier_id: string }>("UPDATE prize_claims SET status = 'EXPIRED' WHERE status = 'ENTITLED' AND expires_at < now() RETURNING id, user_id, prize_tier_id");
    for (const c of r.rows) {
      await audit(db, SYSTEM, "claim.expired", "prize_claim", c.id);
      await notifyExpired(db, c);
    }
    return r.rows.length;
  });
}
