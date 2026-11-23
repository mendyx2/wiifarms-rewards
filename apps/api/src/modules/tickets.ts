import { randomInt } from "node:crypto";
import { MerkleTree, type ProofStep } from "@wiifarm/game-core";
import { SYSTEM, audit, type Actor } from "../audit.ts";
import type { Ctx } from "../context.ts";
import { newToken, open } from "../crypto.ts";
import { lockKey, one, withTx, type Db } from "../db.ts";
import { badRequest, conflict, forbidden, notFound } from "../errors.ts";
import { accounts, post } from "../ledger.ts";
import { assertSimulated, closeIfDue, cycleKeyContext, getCycle, ticketAad } from "./cycles.ts";
import { activeExclusion, getLimits, onExclusionRegister, type User } from "./identity.ts";

const MAX_PER_ORDER = 20;
const RESERVATION_MINUTES = 15;

// --- Buying ---------------------------------------------------------------------------

export interface OrderResult {
  orderId: string; status: string; quantity: number; amountKobo: number;
  /** Reference the (simulated) payment gateway uses to confirm payment. */
  paymentRef: string;
}

/** Total of a player's ticket spending in a rolling window, across every payment method. Pending orders count. */
async function spentSince(db: Db, userId: string, interval: string): Promise<number> {
  const r = await one<{ s: number }>(
    db,
    `SELECT coalesce(sum(amount_kobo), 0)::bigint AS s FROM orders
     WHERE user_id = $1 AND created_at > now() - $2::interval
       AND (status IN ('PAID','FULFILLED') OR (status = 'PENDING' AND reserved_until > now()))`,
    [userId, interval]);
  return r!.s;
}

/** What the player has spent (or committed) in each rolling window, for showing against their limits. */
export async function spending(db: Db, userId: string): Promise<{ dailyKobo: number; weeklyKobo: number; monthlyKobo: number }> {
  return { dailyKobo: await spentSince(db, userId, "24 hours"), weeklyKobo: await spentSince(db, userId, "7 days"), monthlyKobo: await spentSince(db, userId, "30 days") };
}

/** Start of today in Nigeria (UTC+1, no daylight saving), as SQL. */
const LAGOS_TODAY = "(date_trunc('day', now() AT TIME ZONE 'Africa/Lagos') AT TIME ZONE 'Africa/Lagos')";

/** Cards a player has bought (or is paying for) today in a cycle. */
export async function cardsToday(db: Db | Ctx["pool"], userId: string, cycleId: string): Promise<number> {
  const r = await one<{ n: number }>(db,
    `SELECT coalesce(sum(quantity), 0)::int AS n FROM orders
     WHERE user_id = $1 AND cycle_id = $2 AND created_at >= ${LAGOS_TODAY}
       AND (status IN ('PAID','FULFILLED') OR (status = 'PENDING' AND reserved_until > now()))`, [userId, cycleId]);
  return r!.n;
}

export async function createOrder(ctx: Ctx, actor: Actor, user: User, cycleId: string, quantity: number, idempotencyKey: string): Promise<OrderResult> {
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_PER_ORDER) {
    throw badRequest("INVALID_QUANTITY", `You can buy 1 to ${MAX_PER_ORDER} cards at a time.`);
  }
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(idempotencyKey)) throw badRequest("INVALID_IDEMPOTENCY_KEY", "Missing or invalid Idempotency-Key.");

  return withTx(ctx.pool, async (db) => {
    // One purchase at a time per player, so two parallel requests cannot both slip under a limit.
    await lockKey(db, `player:${user.id}`);

    const replay = await one<{ id: string; status: string; quantity: number; amount_kobo: number; cycle_id: string; provider_ref: string }>(
      db,
      `SELECT o.id, o.status, o.quantity, o.amount_kobo, o.cycle_id, p.provider_ref
       FROM orders o JOIN payments p ON p.order_id = o.id WHERE o.user_id = $1 AND o.idempotency_key = $2`,
      [user.id, idempotencyKey]);
    if (replay) {
      if (replay.cycle_id !== cycleId || replay.quantity !== quantity) {
        throw conflict("IDEMPOTENCY_KEY_REUSED", "This request key was already used for a different order.");
      }
      return { orderId: replay.id, status: replay.status, quantity: replay.quantity, amountKobo: replay.amount_kobo, paymentRef: replay.provider_ref };
    }

    const cycle = await getCycle(db, cycleId);
    assertSimulated(cycle);
    const now = Date.now();
    if (cycle.status !== "OPEN" || cycle.sales_open_at.getTime() > now || cycle.sales_close_at.getTime() <= now) {
      throw conflict("SALES_CLOSED", "Sales for this cycle are not open.");
    }

    // Who may buy.
    if (user.kyc_tier < 1) throw forbidden("VERIFICATION_REQUIRED", "Verify your age and identity before buying.");
    if (user.state_code !== cycle.state_code) throw forbidden("OUTSIDE_LICENSED_AREA", "This cycle is not available where you are.");
    const exclusion = await activeExclusion(db, user.id);
    if (exclusion) throw forbidden("SELF_EXCLUDED", "You are taking a break from play, so buying is switched off.");
    if (await onExclusionRegister(db, user)) throw forbidden("NOT_ELIGIBLE", "You are not eligible to take part.");

    // How much they may buy: the season's daily card limit, then the player's own spending limits.
    const today = await cardsToday(db, user.id, cycleId);
    if (today + quantity > cycle.max_tickets_per_day) {
      const left = Math.max(0, cycle.max_tickets_per_day - today);
      throw forbidden("DAILY_CARD_LIMIT", left === 0
        ? `You have bought the most cards allowed in one day (${cycle.max_tickets_per_day}). You can buy more tomorrow.`
        : `You can buy ${left} more cards today (at most ${cycle.max_tickets_per_day} a day).`);
    }
    const amountKobo = quantity * cycle.ticket_price_kobo;
    const limits = await getLimits(db, user.id);
    const windows: [string, number, string][] = [["24 hours", limits.dailyKobo, "daily"], ["7 days", limits.weeklyKobo, "weekly"], ["30 days", limits.monthlyKobo, "monthly"]];
    for (const [interval, limit, label] of windows) {
      if ((await spentSince(db, user.id, interval)) + amountKobo > limit) {
        throw forbidden("SPENDING_LIMIT", `That would take you over your ${label} spending limit.`);
      }
    }
    const held = await one<{ n: number }>(
      db,
      `SELECT (SELECT count(*) FROM tickets WHERE cycle_id = $1 AND owner_id = $2 AND status <> 'CANCELLED')
            + (SELECT coalesce(sum(quantity), 0) FROM orders WHERE cycle_id = $1 AND user_id = $2 AND status = 'PENDING' AND reserved_until > now()) AS n`,
      [cycleId, user.id]);
    if (Number(held!.n) + quantity > cycle.max_tickets_per_account) {
      throw forbidden("CYCLE_CAP", `You can hold at most ${cycle.max_tickets_per_account} cards in this cycle.`);
    }
    // Counts at most `quantity` rows, so this stays fast in a 400,000-card season.
    const unsold = await one<{ n: number }>(db, "SELECT count(*)::int AS n FROM (SELECT 1 FROM tickets WHERE cycle_id = $1 AND status = 'UNSOLD' LIMIT $2) x", [cycleId, quantity]);
    if (unsold!.n < quantity) {
      throw conflict("NOT_ENOUGH_CARDS", unsold!.n === 0 ? "This cycle is sold out." : `Only ${unsold!.n} cards are left.`);
    }

    const order = await db.query<{ id: string }>(
      `INSERT INTO orders (user_id, cycle_id, quantity, amount_kobo, idempotency_key, reserved_until)
       VALUES ($1, $2, $3, $4, $5, now() + make_interval(mins => $6)) RETURNING id`,
      [user.id, cycleId, quantity, amountKobo, idempotencyKey, RESERVATION_MINUTES]);
    const orderId = order.rows[0]!.id;
    const paymentRef = "SIM-" + newToken().token.slice(0, 24);
    await db.query(
      "INSERT INTO payments (order_id, provider, provider_ref, method, amount_kobo, status) VALUES ($1, 'SIMULATED', $2, 'SIMULATED', $3, 'INITIATED')",
      [orderId, paymentRef, amountKobo]);
    await audit(db, actor, "order.created", "order", orderId, { cycleId, quantity, amountKobo });
    return { orderId, status: "PENDING", quantity, amountKobo, paymentRef };
  });
}

export interface PaymentNotice {
  provider: string;
  /** Unique id of this notification, so a redelivery is recognised. */
  eventId: string;
  paymentRef: string;
  amountKobo: number;
  currency: string;
}

/**
 * Handles a "payment succeeded" notification. With a real gateway the caller
 * first checks the webhook signature and re-queries the gateway; the values
 * passed here are the re-queried ones. Everything below happens in ONE
 * database transaction: the payment is recorded, the money is posted to the
 * ledger and the tickets are assigned — or none of it happens.
 */
export async function confirmPayment(ctx: Ctx, notice: PaymentNotice): Promise<{ orderId: string; status: string; ticketIds: string[] }> {
  return withTx(ctx.pool, async (db) => {
    const payment = await one<{ id: string; order_id: string; amount_kobo: number; status: string }>(
      db, "SELECT id, order_id, amount_kobo, status FROM payments WHERE provider = $1 AND provider_ref = $2 FOR NO KEY UPDATE", [notice.provider, notice.paymentRef]);
    if (!payment) throw notFound("Unknown payment.");
    const order = await one<{ id: string; user_id: string; cycle_id: string; quantity: number; amount_kobo: number; status: string }>(
      db, "SELECT id, user_id, cycle_id, quantity, amount_kobo, status FROM orders WHERE id = $1 FOR NO KEY UPDATE", [payment.order_id]);
    if (!order) throw notFound("Unknown order.");

    // Redelivery of a notification we already handled: answer with what happened the first time.
    const fresh = await db.query(
      `INSERT INTO payment_events (provider, provider_event_id, signature_valid, payload, processed_at)
       VALUES ($1, $2, true, $3, now()) ON CONFLICT (provider, provider_event_id) DO NOTHING`,
      [notice.provider, notice.eventId, JSON.stringify(notice)]);
    if (!fresh.rowCount || order.status !== "PENDING") {
      const ids = await db.query<{ id: string }>("SELECT id FROM tickets WHERE order_id = $1 ORDER BY sold_at, id", [order.id]);
      return { orderId: order.id, status: order.status, ticketIds: ids.rows.map((r) => r.id) };
    }

    if (notice.currency !== "NGN" || notice.amountKobo !== order.amount_kobo || payment.amount_kobo !== order.amount_kobo) {
      await db.query(
        "INSERT INTO compliance_alerts (kind, severity, entity_type, entity_id, details) VALUES ('PAYMENT_AMOUNT_MISMATCH', 'CRITICAL', 'order', $1, $2)",
        [order.id, JSON.stringify({ expected: order.amount_kobo, received: notice.amountKobo, currency: notice.currency })]);
      await audit(db, SYSTEM, "payment.amount_mismatch", "order", order.id, { expected: order.amount_kobo, received: notice.amountKobo });
      return { orderId: order.id, status: "PENDING", ticketIds: [] };
    }

    await db.query("UPDATE payments SET status = 'SUCCEEDED', verified_at = now() WHERE id = $1", [payment.id]);

    // Assign cards at random from whatever is unsold. This query cannot see
    // outcomes — they are encrypted. Assignment for one cycle happens one
    // payment at a time: without this, two payments racing for the last cards
    // could each lock part of them, each come up short, both be refunded and
    // leave the cards unsold. (The lock is held only for the rest of this short
    // transaction.) SKIP LOCKED stays as a second guard against double sale.
    await lockKey(db, `cycle-sale:${order.cycle_id}`);
    const cycle = await getCycle(db, order.cycle_id);
    const picked = cycle.status === "OPEN" ? await pickCards(db, cycle.id, cycle.total_tickets, order.quantity) : { rows: [] as { id: string }[] };

    if (picked.rows.length < order.quantity) {
      // Paid, but the cards are gone (sold out or closed meanwhile): refund in full, automatically.
      await post(db, { kind: "REFUND", reference: `order:${order.id}:refund-due`, cycleId: order.cycle_id, debit: accounts.gatewayClearing(), credit: accounts.refundsPayable(), amountKobo: order.amount_kobo });
      const refund = await db.query<{ id: string }>(
        "INSERT INTO refunds (payment_id, order_id, amount_kobo, reason, status) VALUES ($1, $2, $3, 'NO_TICKET_ISSUED', 'CONFIRMED') RETURNING id", [payment.id, order.id, order.amount_kobo]);
      // The simulated gateway refunds instantly; a real one confirms later by webhook.
      await post(db, { kind: "REFUND", reference: `refund:${refund.rows[0]!.id}`, cycleId: order.cycle_id, debit: accounts.refundsPayable(), credit: accounts.gatewayClearing(), amountKobo: order.amount_kobo });
      await db.query("UPDATE orders SET status = 'REFUNDED' WHERE id = $1", [order.id]);
      await audit(db, SYSTEM, "order.refunded_no_ticket", "order", order.id, { amountKobo: order.amount_kobo });
      return { orderId: order.id, status: "REFUNDED", ticketIds: [] };
    }

    const ticketIds = picked.rows.map((r) => r.id);
    await db.query(
      "UPDATE tickets SET status = 'SOLD', owner_id = $2, order_id = $3, sold_at = now() WHERE id = ANY($1::uuid[])",
      [ticketIds, order.user_id, order.id]);
    await post(db, { kind: "TICKET_SALE", reference: `order:${order.id}`, cycleId: order.cycle_id, debit: accounts.gatewayClearing(), credit: accounts.ticketRevenue(order.cycle_id), amountKobo: order.amount_kobo });
    await db.query("UPDATE orders SET status = 'FULFILLED' WHERE id = $1", [order.id]);
    await audit(db, SYSTEM, "order.fulfilled", "order", order.id, { tickets: ticketIds.length, amountKobo: order.amount_kobo });

    // Closing rule: the cycle closes the moment the last card is sold.
    await closeIfDue(db, order.cycle_id);
    return { orderId: order.id, status: "FULFILLED", ticketIds };
  });
}

/**
 * Takes the next unsold cards from a random point in the inventory, wrapping
 * round to the start. The inventory order is itself a secret random shuffle
 * fixed before sales, so any choice of positions is equally fair; starting at a
 * random point avoids sorting every unsold card (400,000 in a large season) on
 * each payment.
 */
async function pickCards(db: Db, cycleId: string, total: number, n: number): Promise<{ rows: { id: string }[] }> {
  const start = randomInt(total);
  const sql = (cmp: string) => `SELECT id FROM tickets WHERE cycle_id = $1 AND status = 'UNSOLD' AND leaf_index ${cmp} $2
                                ORDER BY leaf_index LIMIT $3 FOR NO KEY UPDATE SKIP LOCKED`;
  const a = await db.query<{ id: string }>(sql(">="), [cycleId, start, n]);
  if (a.rows.length >= n) return a;
  const b = await db.query<{ id: string }>(sql("<"), [cycleId, start, n - a.rows.length]);
  return { rows: [...a.rows, ...b.rows] };
}

/** Simulated gateway: the player "pays" and the gateway notifies us. Only exists in simulation. */
export async function simulatePayment(ctx: Ctx, user: User, paymentRef: string): Promise<{ orderId: string; status: string; ticketIds: string[] }> {
  if (!ctx.config.simulated) throw forbidden("NOT_AVAILABLE", "Not available.");
  const p = await one<{ amount_kobo: number }>(
    ctx.pool,
    "SELECT p.amount_kobo FROM payments p JOIN orders o ON o.id = p.order_id WHERE p.provider = 'SIMULATED' AND p.provider_ref = $1 AND o.user_id = $2",
    [paymentRef, user.id]);
  if (!p) throw notFound("Unknown payment.");
  return confirmPayment(ctx, { provider: "SIMULATED", eventId: `${paymentRef}:succeeded`, paymentRef, amountKobo: p.amount_kobo, currency: "NGN" });
}

// --- Viewing and revealing ------------------------------------------------------------------

export interface TicketView {
  id: string; cycleId: string; serial: string; status: string; soldAt: string | null;
  enteredInFinalDraw: boolean;
  /** Present only after the card has been revealed. */
  result?: { outcome: string; cashKobo: number; revealedAt: string };
}

function view(t: { id: string; cycle_id: string; serial: string; status: string; sold_at: Date | null; revealed_at: Date | null; revealed_outcome: string | null }): TicketView {
  const v: TicketView = { id: t.id, cycleId: t.cycle_id, serial: t.serial, status: t.status, soldAt: t.sold_at?.toISOString() ?? null, enteredInFinalDraw: t.status !== "CANCELLED" };
  if (t.revealed_at && t.revealed_outcome) v.result = { outcome: t.revealed_outcome, cashKobo: cashOf(t.revealed_outcome), revealedAt: t.revealed_at.toISOString() };
  return v;
}

const cashOf = (outcome: string): number => {
  const m = /^CASH:(\d+)$/.exec(outcome);
  return m ? Number(m[1]) : 0;
};

export async function listTickets(ctx: Ctx, userId: string, cycleId?: string): Promise<TicketView[]> {
  const r = await ctx.pool.query(
    `SELECT id, cycle_id, serial, status, sold_at, revealed_at, revealed_outcome FROM tickets
     WHERE owner_id = $1 AND ($2::uuid IS NULL OR cycle_id = $2) ORDER BY sold_at DESC, id`, [userId, cycleId ?? null]);
  return r.rows.map(view);
}

// Merkle trees are immutable once a cycle is committed, so they are safe to cache.
const treeCache = new Map<string, MerkleTree>();
async function treeFor(db: Db, cycleId: string): Promise<MerkleTree> {
  let tree = treeCache.get(cycleId);
  if (!tree) {
    const leaves = await db.query<{ leaf_hash: Buffer }>("SELECT leaf_hash FROM tickets WHERE cycle_id = $1 ORDER BY leaf_index", [cycleId]);
    tree = new MerkleTree(leaves.rows.map((r) => r.leaf_hash));
    if (treeCache.size > 20) treeCache.clear();
    treeCache.set(cycleId, tree);
  }
  return tree;
}

export interface RevealResult {
  ticket: TicketView;
  /** Everything needed to check this card against the fingerprint published before sales opened. */
  proof: { cycleId: string; serial: string; outcome: string; salt: string; leafIndex: number; steps: { hash: string; side: ProofStep["side"] }[]; merkleRoot: string };
}

/**
 * Discloses a card's pre-set outcome. Safe to call any number of times: the
 * first call records the reveal and credits any instant prize in the same
 * transaction; later calls return the stored result and credit nothing.
 * `ownerId` is omitted only for the automatic reveal at cycle close.
 */
async function revealInTx(ctx: Ctx, db: Db, ticketId: string, actor: Actor, ownerId?: string, cycleKey?: Buffer): Promise<RevealResult> {
  const t = await one<{ id: string; cycle_id: string; serial: string; leaf_index: number; status: string; owner_id: string | null; sold_at: Date | null; outcome_ciphertext: Buffer; revealed_at: Date | null; revealed_outcome: string | null; revealed_salt: Buffer | null }>(
    db, "SELECT * FROM tickets WHERE id = $1 FOR NO KEY UPDATE", [ticketId]);
  // "Not found" for someone else's card too, so card ids cannot be probed.
  if (!t || !t.owner_id || (ownerId && t.owner_id !== ownerId)) throw notFound("Card not found.");
  if (t.status === "CANCELLED") throw conflict("CARD_CANCELLED", "This card was cancelled.");

  if (t.status === "SOLD") {
    const dataKey = cycleKey ?? await unwrapCycleKey(ctx, db, t.cycle_id);
    const plain = JSON.parse(open(dataKey, t.outcome_ciphertext, ticketAad(t.cycle_id, t.serial)).toString()) as { o: string; s: string };
    if (!cycleKey) dataKey.fill(0);

    const updated = await db.query<{ revealed_at: Date }>(
      "UPDATE tickets SET status = 'REVEALED', revealed_at = now(), revealed_outcome = $2, revealed_salt = $3 WHERE id = $1 RETURNING revealed_at",
      [t.id, plain.o, Buffer.from(plain.s, "hex")]);
    t.status = "REVEALED"; t.revealed_at = updated.rows[0]!.revealed_at; t.revealed_outcome = plain.o; t.revealed_salt = Buffer.from(plain.s, "hex");

    const cash = cashOf(plain.o);
    if (cash > 0) {
      const tier = await one<{ id: string }>(db, "SELECT id FROM prize_tiers WHERE cycle_id = $1 AND stage = 'INSTANT' AND outcome_code = $2", [t.cycle_id, plain.o]);
      const cycle = await getCycle(db, t.cycle_id);
      // The ledger reference and the unique claim are both keyed by the ticket: a second credit is impossible.
      await post(db, { kind: "INSTANT_PRIZE", reference: `ticket:${t.id}:instant`, cycleId: t.cycle_id, debit: accounts.prizeExpense(t.cycle_id), credit: accounts.playerWinnings(t.owner_id), amountKobo: cash });
      await db.query(
        `INSERT INTO prize_claims (ticket_id, stage, prize_tier_id, user_id, status, expires_at)
         VALUES ($1, 'INSTANT', $2, $3, 'PAID', now() + make_interval(days => $4))`,
        [t.id, tier!.id, t.owner_id, cycle.claim_window_days]);
    }
    await audit(db, actor, "ticket.revealed", "ticket", t.id, { cycleId: t.cycle_id, instantCashKobo: cash });
  }

  const tree = await treeFor(db, t.cycle_id);
  return {
    ticket: view(t),
    proof: {
      cycleId: t.cycle_id, serial: t.serial, outcome: t.revealed_outcome!, salt: t.revealed_salt!.toString("hex"), leafIndex: t.leaf_index,
      steps: tree.proof(t.leaf_index).map((s) => ({ hash: s.hash.toString("hex"), side: s.side })),
      merkleRoot: tree.root.toString("hex"),
    },
  };
}

async function unwrapCycleKey(ctx: Ctx, db: Db, cycleId: string): Promise<Buffer> {
  const secrets = await one<{ wrapped_data_key: Buffer }>(db, "SELECT wrapped_data_key FROM cycle_secrets WHERE cycle_id = $1", [cycleId]);
  return ctx.keys.unwrap(secrets!.wrapped_data_key, cycleKeyContext(cycleId));
}

export async function revealTicket(ctx: Ctx, actor: Actor, userId: string, ticketId: string): Promise<RevealResult> {
  return withTx(ctx.pool, (db) => revealInTx(ctx, db, ticketId, actor, userId));
}

/** After a cycle closes, every sold card that was never scratched is revealed so no winner misses out. */
export async function autoRevealCycle(ctx: Ctx, cycleId: string): Promise<number> {
  const cycle = await getCycle(ctx.pool, cycleId);
  if (!["CLOSED", "DRAWN", "SETTLING"].includes(cycle.status)) throw conflict("NOT_CLOSED", "Cards are auto-revealed only after the cycle closes.");
  const pending = await ctx.pool.query<{ id: string }>("SELECT id FROM tickets WHERE cycle_id = $1 AND status = 'SOLD' ORDER BY leaf_index", [cycleId]);
  // In batches: one key-service call and one transaction per 500 cards, not per card.
  const BATCH = 500;
  for (let i = 0; i < pending.rows.length; i += BATCH) {
    await withTx(ctx.pool, async (db) => {
      const key = await unwrapCycleKey(ctx, db, cycleId);
      try {
        for (const { id } of pending.rows.slice(i, i + BATCH)) await revealInTx(ctx, db, id, SYSTEM, undefined, key);
      } finally { key.fill(0); }
    });
  }
  return pending.rows.length;
}
