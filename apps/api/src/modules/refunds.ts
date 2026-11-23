import { audit } from "../audit.ts";
import { naira, notify } from "./notify.ts";
import type { Ctx } from "../context.ts";
import { lockKey, one, withTx, type Db } from "../db.ts";
import { badRequest, conflict, forbidden, notFound } from "../errors.ts";
import { accounts, post } from "../ledger.ts";
import { adminActor, requireRole, type Admin } from "./admin.ts";
import { getCycle } from "./cycles.ts";
import { winningsBalance } from "./wallet.ts";

/**
 * Refunds and cancelled cycles.
 *
 * Manual refunds (a purchase that should not have been allowed, or a disputed
 * payment) are requested by Compliance and approved by Finance — never the
 * same person. The order's cards are cancelled and any prizes they won are
 * forfeited. Cancelling a whole cycle is requested by a cycle manager or
 * Compliance and approved by Finance or Compliance; every card is refunded,
 * and instant prizes already revealed are honoured. Refunds always go back to
 * the original payment.
 */

type ManualReason = "INELIGIBLE_PURCHASE" | "DISPUTED_PAYMENT";

function dbRule(err: unknown): never {
  const e = err as { code?: string; message?: string; constraint?: string };
  if (e.code === "23505" && e.constraint === "refunds_one_per_order") throw conflict("ALREADY_REFUNDED", "This purchase already has a refund or a refund request.");
  if (e.code === "23505" && e.constraint === "cycle_void_requests_one_live") throw conflict("VOID_ALREADY_REQUESTED", "A cancellation request for this cycle is already open.");
  if (e.code === "23000") throw conflict("RULE_VIOLATION", e.message ?? "Not allowed.");
  if (e.code === "23514") throw conflict("RULE_VIOLATION", "That is not allowed by the rules (for example, the same person requesting and approving).");
  throw err;
}

/** Posts the refund to the ledger: revenue is reversed and the money goes back out through the gateway. */
async function postRefund(db: Db, refundId: string, orderId: string, cycleId: string, amountKobo: number): Promise<void> {
  await post(db, { kind: "REFUND", reference: `order:${orderId}:refund-due`, cycleId, debit: accounts.ticketRevenue(cycleId), credit: accounts.refundsPayable(), amountKobo });
  // The simulated gateway refunds at once; a real one confirms later by webhook.
  await post(db, { kind: "REFUND", reference: `refund:${refundId}`, cycleId, debit: accounts.refundsPayable(), credit: accounts.gatewayClearing(), amountKobo });
}

// --- Finding purchases ----------------------------------------------------------------------

export async function searchOrders(ctx: Ctx, admin: Admin, q: { phone?: string; cycleId?: string }): Promise<unknown[]> {
  requireRole(admin, "COMPLIANCE", "FINANCE", "SUPPORT", "AUDITOR");
  if (!q.phone && !q.cycleId) throw badRequest("SEARCH_REQUIRED", "Search by phone number or cycle.");
  const digits = q.phone?.replace(/\D/g, "").replace(/^0/, "").replace(/^234/, "") ?? null;
  const r = await ctx.pool.query(
    `SELECT o.id, o.created_at, o.quantity, o.amount_kobo, o.status, c.name AS cycle, c.status AS cycle_status,
            u.full_name AS player_name, '…' || right(u.phone_e164, 4) AS player_phone,
            rf.id AS refund_id, rf.status AS refund_status, rf.reason AS refund_reason
     FROM orders o JOIN users u ON u.id = o.user_id JOIN cycles c ON c.id = o.cycle_id
     LEFT JOIN LATERAL (SELECT id, status, reason FROM refunds WHERE order_id = o.id ORDER BY created_at DESC LIMIT 1) rf ON true
     WHERE ($1::text IS NULL OR u.phone_e164 = '+234' || $1) AND ($2::uuid IS NULL OR o.cycle_id = $2)
     ORDER BY o.created_at DESC LIMIT 200`,
    [digits && digits.length >= 10 ? digits : digits ? "no-match" : null, q.cycleId ?? null]);
  return r.rows;
}

export async function listRefunds(ctx: Ctx, admin: Admin, status?: string): Promise<unknown[]> {
  requireRole(admin, "COMPLIANCE", "FINANCE", "AUDITOR");
  const r = await ctx.pool.query(
    `SELECT rf.id, rf.order_id, rf.amount_kobo, rf.reason, rf.status, rf.note, rf.created_at, rf.decided_at, rf.decision_reason,
            rq.full_name AS requested_by_name, rf.requested_by, ap.full_name AS decided_by_name,
            c.name AS cycle, o.quantity, '…' || right(u.phone_e164, 4) AS player_phone, u.full_name AS player_name
     FROM refunds rf JOIN orders o ON o.id = rf.order_id JOIN cycles c ON c.id = o.cycle_id JOIN users u ON u.id = o.user_id
     LEFT JOIN admin_users rq ON rq.id = rf.requested_by LEFT JOIN admin_users ap ON ap.id = rf.approved_by
     WHERE ($1::text IS NULL OR rf.status = $1) ORDER BY rf.created_at DESC LIMIT 200`, [status ?? null]);
  return r.rows;
}

// --- Manual refunds -------------------------------------------------------------------------------

/**
 * Merchandise that has already been allocated, sent or handed over cannot be
 * undone by a refund; those claims must be resolved first.
 */
async function assertPrizesReversible(db: Db, orderId: string): Promise<void> {
  const blocked = await one<{ title: string; status: string }>(db,
    `SELECT pt.title, pc.status FROM prize_claims pc JOIN prize_tiers pt ON pt.id = pc.prize_tier_id JOIN tickets t ON t.id = pc.ticket_id
     WHERE t.order_id = $1 AND pt.kind = 'MERCHANDISE' AND pc.status IN ('VERIFIED','DISPATCHED','DELIVERED') LIMIT 1`, [orderId]);
  if (blocked) throw conflict("PRIZE_IN_FULFILMENT", `A card in this purchase won "${blocked.title}", which is already being delivered. Resolve that claim before refunding.`);
}

export async function requestRefund(ctx: Ctx, admin: Admin, orderId: string, input: { reason: ManualReason; note: string }): Promise<{ id: string; status: string }> {
  requireRole(admin, "COMPLIANCE");
  if (!input.note.trim()) throw badRequest("NOTE_REQUIRED", "Explain why this purchase is being refunded.");
  return withTx(ctx.pool, async (db) => {
    const order = await one<{ id: string; status: string; amount_kobo: number }>(db, "SELECT id, status, amount_kobo FROM orders WHERE id = $1 FOR NO KEY UPDATE", [orderId]);
    if (!order) throw notFound("Purchase not found.");
    if (order.status !== "FULFILLED") throw conflict("NOT_REFUNDABLE", "Only a completed purchase can be refunded.");
    await assertPrizesReversible(db, orderId);
    const payment = await one<{ id: string }>(db, "SELECT id FROM payments WHERE order_id = $1 AND status = 'SUCCEEDED'", [orderId]);
    const r = await db.query<{ id: string }>(
      `INSERT INTO refunds (payment_id, order_id, amount_kobo, reason, status, requested_by, note) VALUES ($1, $2, $3, $4, 'AWAITING_APPROVAL', $5, $6) RETURNING id`,
      [payment!.id, orderId, order.amount_kobo, input.reason, admin.id, input.note.trim()]).catch(dbRule);
    await audit(db, adminActor(admin), "refund.requested", "order", orderId, { refundId: r.rows[0]!.id, reason: input.reason });
    return { id: r.rows[0]!.id, status: "AWAITING_APPROVAL" };
  });
}

/**
 * Finance approves or rejects a refund request. On approval, in one
 * transaction: the order's cards are cancelled, any prize they won is
 * forfeited (cash taken back from the player's winnings), the price goes back
 * to the original payment, and the order is marked refunded.
 */
export async function decideRefund(ctx: Ctx, admin: Admin, refundId: string, approve: boolean, reason?: string): Promise<{ status: string }> {
  requireRole(admin, "FINANCE");
  return withTx(ctx.pool, async (db) => {
    const rf = await one<{ id: string; order_id: string; status: string; amount_kobo: number; requested_by: string | null; reason: string }>(
      db, "SELECT id, order_id, status, amount_kobo, requested_by, reason FROM refunds WHERE id = $1 FOR NO KEY UPDATE", [refundId]);
    if (!rf) throw notFound("Refund request not found.");
    if (rf.status !== "AWAITING_APPROVAL") throw conflict("ALREADY_DECIDED", "This refund request has already been decided.");
    if (rf.requested_by === admin.id) throw forbidden("SAME_PERSON", "You requested this refund, so someone else must decide it.");
    if (!approve) {
      if (!reason?.trim()) throw badRequest("REASON_REQUIRED", "Give a reason for rejecting the refund.");
      await db.query("UPDATE refunds SET status = 'REJECTED', approved_by = $2, decided_at = now(), decision_reason = $3 WHERE id = $1", [rf.id, admin.id, reason.trim()]).catch(dbRule);
      await audit(db, adminActor(admin), "refund.rejected", "order", rf.order_id, { refundId: rf.id, reason });
      return { status: "REJECTED" };
    }

    const order = await one<{ id: string; user_id: string; cycle_id: string; status: string }>(db, "SELECT id, user_id, cycle_id, status FROM orders WHERE id = $1 FOR NO KEY UPDATE", [rf.order_id]);
    if (order!.status !== "FULFILLED") throw conflict("NOT_REFUNDABLE", "This purchase is no longer refundable.");
    await lockKey(db, `player:${order!.user_id}`);
    await assertPrizesReversible(db, order!.id);

    // Forfeit what the cancelled cards won. Cash comes back out of the player's winnings.
    const won = await db.query<{ claim_id: string; ticket_id: string; stage: string; kind: string; cash_kobo: number | null; status: string }>(
      `SELECT pc.id AS claim_id, pc.ticket_id, pc.stage, pt.kind, pt.cash_kobo, pc.status FROM prize_claims pc
       JOIN prize_tiers pt ON pt.id = pc.prize_tier_id JOIN tickets t ON t.id = pc.ticket_id
       WHERE t.order_id = $1 AND pc.status NOT IN ('VOID','EXPIRED') FOR NO KEY UPDATE OF pc`, [order!.id]);
    let forfeitedKobo = 0;
    for (const w of won.rows) {
      await db.query("UPDATE prize_claims SET status = 'VOID', hold_reason = NULL WHERE id = $1", [w.claim_id]);
      if (w.kind === "CASH" && w.status === "PAID") {
        await post(db, { kind: "ADJUSTMENT", reference: `ticket:${w.ticket_id}:${w.stage === "INSTANT" ? "instant" : "draw"}:forfeit`, cycleId: order!.cycle_id,
          memo: "Prize forfeited: purchase refunded", debit: accounts.playerWinnings(order!.user_id), credit: accounts.prizeExpense(order!.cycle_id), amountKobo: w.cash_kobo! });
        forfeitedKobo += w.cash_kobo!;
      }
    }

    await db.query("UPDATE tickets SET status = 'CANCELLED' WHERE order_id = $1 AND status IN ('SOLD','REVEALED')", [order!.id]);
    await db.query("UPDATE refunds SET status = 'CONFIRMED', approved_by = $2, decided_at = now(), provider_ref = $3 WHERE id = $1",
      [rf.id, admin.id, `SIMRF-${rf.id}`]).catch(dbRule);
    await postRefund(db, rf.id, order!.id, order!.cycle_id, rf.amount_kobo);
    await db.query("UPDATE orders SET status = 'REFUNDED' WHERE id = $1", [order!.id]);

    // Winnings already withdrawn cannot be taken back automatically: flag them for recovery.
    const balance = await winningsBalance(db, order!.user_id);
    if (balance < 0) {
      await db.query("INSERT INTO compliance_alerts (kind, severity, entity_type, entity_id, details) VALUES ('PRIZE_RECOVERY_REQUIRED', 'CRITICAL', 'user', $1, $2)",
        [order!.user_id, JSON.stringify({ owedKobo: -balance, orderId: order!.id })]);
    }
    if (rf.reason === "DISPUTED_PAYMENT") {
      await db.query("INSERT INTO compliance_alerts (kind, severity, entity_type, entity_id, details) VALUES ('DISPUTED_PAYMENT', 'WARNING', 'user', $1, $2)",
        [order!.user_id, JSON.stringify({ orderId: order!.id })]);
    }
    await audit(db, adminActor(admin), "refund.approved", "order", order!.id, { refundId: rf.id, amountKobo: rf.amount_kobo, forfeitedKobo });
    await notify(db, { userId: order!.user_id, kind: "REFUND", urgent: true, link: "#/me", dedupeKey: `refund:${rf.id}`,
      title: `${naira(rf.amount_kobo)} refunded`,
      body: `A purchase of yours was refunded (${naira(rf.amount_kobo)}) to the payment it came from, and its cards were cancelled.` + (forfeitedKobo ? ` Prizes won on those cards (${naira(forfeitedKobo)}) are no longer yours.` : "") + " Contact support if you have questions.",
      sms: `A purchase of ${naira(rf.amount_kobo)} was refunded to the payment it came from and its cards were cancelled. Details are in the app.`,
      ha: { title: `An mayar da ${naira(rf.amount_kobo)}`,
        body: `An mayar maka da kuɗin wata sayayyarka (${naira(rf.amount_kobo)}) ta hanyar da aka biya, kuma an soke katunanta.` + (forfeitedKobo ? ` Kyaututtukan da waɗannan katunan suka ci (${naira(forfeitedKobo)}) ba naka ba ne yanzu.` : "") + " Tuntuɓi masu taimako idan kana da tambayoyi.",
        sms: `An mayar da sayayyar ${naira(rf.amount_kobo)} ta hanyar da aka biya kuma an soke katunanta. Bayani yana cikin manhajar.` } });
    return { status: "CONFIRMED" };
  });
}

// --- Cancelling a cycle ------------------------------------------------------------------------------

const VOIDABLE = ["APPROVED", "COMMITTED", "OPEN", "CLOSED"];

export async function requestVoid(ctx: Ctx, admin: Admin, cycleId: string, reason: string): Promise<{ id: string }> {
  requireRole(admin, "CYCLE_MANAGER", "COMPLIANCE");
  if (!reason.trim()) throw badRequest("REASON_REQUIRED", "Explain why the cycle must be cancelled.");
  return withTx(ctx.pool, async (db) => {
    const cycle = await getCycle(db, cycleId, true);
    if (!VOIDABLE.includes(cycle.status)) {
      throw conflict("NOT_VOIDABLE", cycle.status === "DRAFT" || cycle.status === "SUBMITTED"
        ? "This cycle has not been approved; it can simply be left unpublished."
        : "A cycle cannot be cancelled once its draw has taken place.");
    }
    const r = await db.query<{ id: string }>("INSERT INTO cycle_void_requests (cycle_id, reason, requested_by) VALUES ($1, $2, $3) RETURNING id",
      [cycleId, reason.trim(), admin.id]).catch(dbRule);
    await audit(db, adminActor(admin), "cycle.void_requested", "cycle", cycleId, { reason });
    return { id: r.rows[0]!.id };
  });
}

/**
 * A second person approves or rejects the cancellation. On approval, in one
 * transaction: the cycle becomes VOID, every paid purchase is refunded in full
 * to the original payment, every card is cancelled, instant prizes already
 * revealed stay with their winners, pending refund requests are superseded,
 * reserved merchandise goes back into stock, and Compliance is alerted so the
 * regulator can be told.
 */
export async function decideVoid(ctx: Ctx, admin: Admin, cycleId: string, approve: boolean, reason?: string): Promise<{ status: string; refunds?: number; refundedKobo?: number }> {
  requireRole(admin, "FINANCE", "COMPLIANCE");
  return withTx(ctx.pool, async (db) => {
    const cycle = await getCycle(db, cycleId, true);
    const req = await one<{ id: string; requested_by: string; reason: string }>(db,
      "SELECT id, requested_by, reason FROM cycle_void_requests WHERE cycle_id = $1 AND status = 'PENDING' FOR NO KEY UPDATE", [cycleId]);
    if (!req) throw notFound("There is no open cancellation request for this cycle.");
    if (req.requested_by === admin.id) throw forbidden("SAME_PERSON", "You requested this cancellation, so someone else must decide it.");
    if (!approve) {
      if (!reason?.trim()) throw badRequest("REASON_REQUIRED", "Give a reason for rejecting the cancellation.");
      await db.query("UPDATE cycle_void_requests SET status = 'REJECTED', decided_by = $2, decided_at = now(), decision_reason = $3 WHERE id = $1", [req.id, admin.id, reason.trim()]).catch(dbRule);
      await audit(db, adminActor(admin), "cycle.void_rejected", "cycle", cycleId, { reason });
      return { status: "REJECTED" };
    }
    if (!VOIDABLE.includes(cycle.status)) throw conflict("NOT_VOIDABLE", "A cycle cannot be cancelled once its draw has taken place.");

    await db.query("UPDATE cycle_void_requests SET status = 'APPROVED', decided_by = $2, decided_at = now() WHERE id = $1", [req.id, admin.id]).catch(dbRule);
    await db.query("UPDATE cycles SET status = 'VOID' WHERE id = $1", [cycleId]).catch(dbRule);

    // Open manual refund requests are replaced by the full refund below.
    await db.query(
      `UPDATE refunds SET status = 'REJECTED', decided_at = now(), decision_reason = 'Superseded: cycle cancelled and all purchases refunded'
       WHERE status = 'AWAITING_APPROVAL' AND order_id IN (SELECT id FROM orders WHERE cycle_id = $1)`, [cycleId]);

    const orders = await db.query<{ id: string; amount_kobo: number; payment_id: string }>(
      `SELECT o.id, o.amount_kobo, p.id AS payment_id FROM orders o JOIN payments p ON p.order_id = o.id AND p.status = 'SUCCEEDED'
       WHERE o.cycle_id = $1 AND o.status = 'FULFILLED' ORDER BY o.created_at FOR NO KEY UPDATE OF o`, [cycleId]);
    let refundedKobo = 0;
    const cycleName = (await one<{ name: string }>(db, "SELECT name FROM cycles WHERE id = $1", [cycleId]))!.name;
    for (const o of orders.rows) {
      const owner = (await one<{ user_id: string }>(db, "SELECT user_id FROM orders WHERE id = $1", [o.id]))!.user_id;
      await notify(db, { userId: owner, kind: "CYCLE_CANCELLED", urgent: true, link: "#/me", dedupeKey: `void:${cycleId}:${o.id}`,
        title: `${cycleName} was cancelled`, body: `${cycleName} was cancelled. Your purchase of ${naira(o.amount_kobo)} has been refunded in full to the payment it came from. Instant prizes you already revealed are yours to keep.`,
        sms: `${cycleName} was cancelled. Your ${naira(o.amount_kobo)} has been refunded in full. Instant prizes already revealed are yours to keep.`,
        ha: { title: `An soke ${cycleName}`,
          body: `An soke ${cycleName}. An mayar maka da sayayyarka ta ${naira(o.amount_kobo)} gaba ɗaya ta hanyar da aka biya. Kyaututtukan nan take da ka riga ka bayyana naka ne.`,
          sms: `An soke ${cycleName}. An mayar maka da ${naira(o.amount_kobo)} naka gaba ɗaya. Kyaututtukan nan take da aka riga aka bayyana naka ne.` } });
      const r = await db.query<{ id: string }>(
        `INSERT INTO refunds (payment_id, order_id, amount_kobo, reason, status, requested_by, approved_by, decided_at, provider_ref)
         VALUES ($1, $2, $3, 'CYCLE_VOID', 'CONFIRMED', $4, $5, now(), $6) RETURNING id`,
        [o.payment_id, o.id, o.amount_kobo, req.requested_by, admin.id, `SIMRF-void-${o.id}`]).catch(dbRule);
      await postRefund(db, r.rows[0]!.id, o.id, cycleId, o.amount_kobo);
      await db.query("UPDATE orders SET status = 'REFUNDED' WHERE id = $1", [o.id]);
      refundedKobo += o.amount_kobo;
    }
    // Unscratched cards can no longer be revealed; prizes already revealed are kept by their winners.
    const cancelled = await db.query("UPDATE tickets SET status = 'CANCELLED' WHERE cycle_id = $1 AND status IN ('SOLD','REVEALED')", [cycleId]);
    const released = await db.query("UPDATE stock_units SET status = 'IN_STOCK', reserved_cycle_id = NULL WHERE reserved_cycle_id = $1 AND status = 'RESERVED'", [cycleId]).catch(dbRule);

    await db.query("INSERT INTO compliance_alerts (kind, severity, entity_type, entity_id, details) VALUES ('CYCLE_VOIDED', 'WARNING', 'cycle', $1, $2)",
      [cycleId, JSON.stringify({ reason: req.reason, refunds: orders.rows.length, refundedKobo, reportToRegulator: true })]);
    await audit(db, adminActor(admin), "cycle.voided", "cycle", cycleId,
      { reason: req.reason, refunds: orders.rows.length, refundedKobo, cardsCancelled: cancelled.rowCount, stockReleased: released.rowCount });
    return { status: "VOID", refunds: orders.rows.length, refundedKobo };
  });
}

/** A player's own purchases, with any refund. */
export async function listMyOrders(ctx: Ctx, userId: string): Promise<unknown[]> {
  const r = await ctx.pool.query(
    `SELECT o.id, o.created_at, o.quantity, o.amount_kobo, o.status, c.name AS cycle, rf.reason AS refund_reason, rf.created_at AS refunded_at
     FROM orders o JOIN cycles c ON c.id = o.cycle_id
     LEFT JOIN refunds rf ON rf.order_id = o.id AND rf.status = 'CONFIRMED'
     WHERE o.user_id = $1 AND o.status IN ('FULFILLED','REFUNDED') ORDER BY o.created_at DESC LIMIT 100`, [userId]);
  return r.rows;
}
