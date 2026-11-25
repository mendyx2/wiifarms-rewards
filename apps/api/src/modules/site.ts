import type { Ctx } from "../context.ts";
import { one, withTx } from "../db.ts";
import { audit } from "../audit.ts";
import { badRequest, notFound } from "../errors.ts";
import { adminActor, requireRole, type Admin } from "./admin.ts";
import { GAME_CORE_VERSION } from "./cycles.ts";

/**
 * Data for the public website pages (SRS section 5, WEB-001 to WEB-015) that
 * are not already served elsewhere: the prize catalogue (WEB-003), About us
 * with licensing (WEB-010) and previous campaigns with their results and
 * fulfilment (WEB-015). Everything here is public and never identifies a
 * player.
 */

const PUBLIC_STATUSES = "('COMMITTED','OPEN','CLOSED','DRAWN','SETTLING','ARCHIVED')";

/** WEB-003: every prize of a campaign, with what the SRS says each prize page must show. */
export async function catalogue(ctx: Ctx, cycleId: string): Promise<unknown> {
  const c = await one<{ id: string; name: string; claim_window_days: number; draw_at: Date; status: string }>(ctx.pool,
    `SELECT id, name, claim_window_days, draw_at, status FROM cycles WHERE id = $1 AND status IN ${PUBLIC_STATUSES}`, [cycleId]);
  if (!c) throw notFound("Campaign not found.");
  const prizes = (await ctx.pool.query(
    `SELECT p.id, p.stage, p.kind, p.title, p.quantity, p.cash_kobo, p.draw_order,
            k.description, k.advertised_value_kobo, k.warranty_months, k.retail_url, k.redemption_notes, k.serialised,
            EXISTS (SELECT 1 FROM prize_images i WHERE i.prize_tier_id = p.id) AS has_image,
            (SELECT array_agg(DISTINCT sp.name ORDER BY sp.name) FROM stock_units u JOIN purchase_orders po ON po.id = u.purchase_order_id JOIN suppliers sp ON sp.id = po.supplier_id
              WHERE u.sku_id = p.sku_id AND u.reserved_cycle_id = p.cycle_id) AS suppliers
     FROM prize_tiers p LEFT JOIN skus k ON k.id = p.sku_id WHERE p.cycle_id = $1
     ORDER BY p.stage DESC, p.draw_order NULLS LAST, p.cash_kobo DESC NULLS LAST`, [cycleId])).rows
    .map((r) => ({ ...r, cash_kobo: r.cash_kobo === null ? null : Number(r.cash_kobo), value_kobo: Number(r.cash_kobo ?? r.advertised_value_kobo),
      advertised_value_kobo: undefined, suppliers: r.suppliers ?? [] }));
  const centres = (await one<{ n: number }>(ctx.pool, "SELECT count(*)::int AS n FROM stockists WHERE status = 'ACTIVE' AND tier <> 'SPECIALIST'"))!.n;
  return { campaign: { id: c.id, name: c.name, drawAt: c.draw_at, status: c.status, claimWindowDays: c.claim_window_days }, prizes, collectionCentres: centres };
}

/** WEB-010: who runs the platform, and the licences and certifications that are verified and in force. */
export async function about(ctx: Ctx): Promise<unknown> {
  const licences = (await ctx.pool.query(
    `SELECT state_code, authority, licence_number, valid_from::text, valid_to::text FROM licences
     WHERE status = 'VERIFIED' AND current_date BETWEEN valid_from AND valid_to ORDER BY state_code`)).rows;
  const certifications = (await ctx.pool.query(
    `SELECT component, component_version, lab, certificate_ref, valid_from::text, valid_to::text FROM certifications
     WHERE status = 'VERIFIED' AND current_date >= valid_from AND (valid_to IS NULL OR current_date <= valid_to) ORDER BY component`)).rows;
  const co = ctx.config.company ?? {};
  return {
    company: { name: co.name ?? "WiiFarm Rewards & Lotto", registration: co.registration ?? null, address: co.address ?? null, email: co.email ?? null },
    licences, certifications, engineFingerprint: GAME_CORE_VERSION,
    simulated: ctx.config.simulated,
  };
}

/** WEB-015: finished and cancelled campaigns, their results and how their prizes were fulfilled. */
export async function pastCampaigns(ctx: Ctx): Promise<unknown> {
  const rows = (await ctx.pool.query(
    `SELECT c.id, c.name, c.status, c.sales_open_at, c.sales_close_at, c.draw_at, c.total_tickets, c.ticket_price_kobo,
            (SELECT count(*) FROM tickets t WHERE t.cycle_id = c.id AND t.status IN ('SOLD','REVEALED'))::int AS cards_sold,
            (SELECT count(*) FROM prize_claims pc JOIN prize_tiers pt ON pt.id = pc.prize_tier_id WHERE pt.cycle_id = c.id AND pc.stage = 'INSTANT' AND pc.status <> 'VOID')::int AS instant_wins,
            (SELECT coalesce(sum(pt.cash_kobo), 0) FROM prize_claims pc JOIN prize_tiers pt ON pt.id = pc.prize_tier_id WHERE pt.cycle_id = c.id AND pc.stage = 'INSTANT' AND pc.status <> 'VOID')::bigint AS instant_cash_kobo,
            (SELECT count(*) FROM draw_winners w WHERE w.cycle_id = c.id)::int AS draw_winners,
            (SELECT count(*) FROM prize_claims pc JOIN prize_tiers pt ON pt.id = pc.prize_tier_id WHERE pt.cycle_id = c.id AND pt.kind = 'MERCHANDISE')::int AS goods_won,
            (SELECT count(*) FROM prize_claims pc JOIN prize_tiers pt ON pt.id = pc.prize_tier_id WHERE pt.cycle_id = c.id AND pt.kind = 'MERCHANDISE' AND pc.status = 'DELIVERED')::int AS goods_delivered,
            (SELECT count(*) FROM prize_claims pc JOIN prize_tiers pt ON pt.id = pc.prize_tier_id WHERE pt.cycle_id = c.id AND pt.kind = 'MERCHANDISE' AND pc.status IN ('ENTITLED','ON_HOLD','VERIFIED','DISPATCHED'))::int AS goods_outstanding,
            (SELECT count(*) FROM prize_claims pc JOIN prize_tiers pt ON pt.id = pc.prize_tier_id WHERE pt.cycle_id = c.id AND pt.kind = 'MERCHANDISE' AND pc.status = 'EXPIRED')::int AS goods_unclaimed,
            (SELECT d.executed_at FROM draws d WHERE d.cycle_id = c.id) AS drawn_at
     FROM cycles c
     WHERE c.status IN ('DRAWN','SETTLING','ARCHIVED') OR (c.status = 'VOID' AND EXISTS (SELECT 1 FROM cycle_commitments cc WHERE cc.cycle_id = c.id))
     ORDER BY c.draw_at DESC LIMIT 50`)).rows;
  return { campaigns: rows.map((r) => ({ ...r, instant_cash_kobo: Number(r.instant_cash_kobo) })) };
}

/** Catalogue details kept with each product: its description, an ordinary retail link and redemption notes. */
export async function setCatalogueDetails(ctx: Ctx, admin: Admin, skuId: string, input: { description?: string; retailUrl?: string | null; redemptionNotes?: string }): Promise<{ id: string }> {
  requireRole(admin, "FULFILMENT", "CYCLE_MANAGER");
  if (input.retailUrl && !/^https:\/\/[^\s<>"]+$/.test(input.retailUrl)) throw badRequest("INVALID_URL", "The retail link must be a full https:// address.");
  return withTx(ctx.pool, async (db) => {
    const r = await db.query(
      `UPDATE skus SET description = coalesce($2, description), retail_url = CASE WHEN $5 THEN $3 ELSE retail_url END, redemption_notes = coalesce($4, redemption_notes)
       WHERE id = $1`, [skuId, input.description?.trim() || null, input.retailUrl?.trim() || null, input.redemptionNotes?.trim() || null, input.retailUrl !== undefined]);
    if (!r.rowCount) throw notFound("Item not found.");
    await audit(db, adminActor(admin), "sku.catalogue_updated", "sku", skuId, { ...input });
    return { id: skuId };
  });
}
