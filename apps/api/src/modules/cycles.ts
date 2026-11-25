import { randomBytes } from "node:crypto";
import { PackedMerkleTree, commitSecret, generateOutcomes, ticketLeafHash } from "@wiifarm/game-core";
import { SYSTEM, audit, type Actor } from "../audit.ts";
import type { Ctx } from "../context.ts";
import { seal, sha256 } from "../crypto.ts";
import { one, withTx, type Db } from "../db.ts";
import { AppError, badRequest, conflict, notFound } from "../errors.ts";
import { adminActor, requireRole, type Admin } from "./admin.ts";
import { stockCover } from "./inventory.ts";
import { engineVersion } from "@wiifarm/game-core/tools/digest.ts";
import { POLICY, share } from "../policy.ts";

/**
 * Identifies the exact engine code that generates a cycle: release plus a
 * SHA-256 fingerprint of every engine source file. It is written into each
 * cycle's published commitment, and a certification only counts if it names
 * this exact string — so changing the engine without re-certifying shuts the
 * real-money gate automatically.
 */
export const GAME_CORE_VERSION = engineVersion();

export interface CycleRow {
  id: string; name: string; mode: string; state_code: string; status: string;
  ticket_price_kobo: number; total_tickets: number; max_tickets_per_account: number; max_tickets_per_day: number; levels: number;
  prize_share_bp: number; instant_share_bp: number;
  sales_open_at: Date; sales_close_at: Date; draw_at: Date; claim_window_days: number;
  rules_document_ref: string | null; auditor_admin_id: string | null; created_by: string; rules_sha256: Buffer | null;
}

/**
 * `lock` takes a row lock that serialises status changes for the cycle without
 * blocking the many transactions that merely reference it (orders, ledger rows).
 */
export async function getCycle(db: Db | Ctx["pool"], id: string, forUpdate = false): Promise<CycleRow> {
  const c = await one<CycleRow>(db, `SELECT * FROM cycles WHERE id = $1 ${forUpdate ? "FOR NO KEY UPDATE" : ""}`, [id]);
  if (!c) throw notFound("Cycle not found.");
  return c;
}

/** Turns a database rule violation into a readable 409 instead of a 500. */
function asConflict(err: unknown): never {
  const e = err as { code?: string; message?: string };
  // Rules written in the database carry a readable message; built-in constraint errors do not.
  if (e.code === "23000") throw conflict("RULE_VIOLATION", e.message ?? "Not allowed.");
  if (e.code === "23514") throw conflict("RULE_VIOLATION", "One of the values is outside what the rules allow. Check the amounts, quantities and dates.");
  if (e.code === "23505") throw conflict("RULE_VIOLATION", "That already exists for this cycle.");
  throw err;
}

// --- Drafting ---------------------------------------------------------------------

export interface NewCycle {
  name: string; ticketPriceKobo: number; totalTickets: number; maxTicketsPerAccount: number;
  salesOpenAt: string; salesCloseAt: string; drawAt: string; claimWindowDays?: number;
  /** Sold in this many equal levels, each holding its share of the instant prizes (default 1). */
  levels?: number;
}

export async function createCycle(ctx: Ctx, admin: Admin, input: NewCycle): Promise<{ id: string }> {
  requireRole(admin, "CYCLE_MANAGER");
  // Brief section 2: tickets are initially priced between ₦200 and ₦500.
  if (input.ticketPriceKobo < 20_000 || input.ticketPriceKobo > 50_000) {
    throw badRequest("INVALID_PRICE", "Ticket price must be between ₦200 and ₦500.");
  }
  const policy = ctx.config.policy ?? POLICY;
  const levels = input.levels ?? 1;
  if (!Number.isInteger(levels) || levels < 1 || levels > 20 || input.totalTickets % levels !== 0) {
    throw badRequest("INVALID_LEVELS", "The number of cards must divide equally into the levels (1 to 20).");
  }
  return withTx(ctx.pool, async (db) => {
    // Every cycle is SIMULATED in Phase 2. Real-money cycles cannot be created through this API at all.
    const r = await db.query<{ id: string }>(
      `INSERT INTO cycles (name, mode, ticket_price_kobo, total_tickets, max_tickets_per_account,
                           sales_open_at, sales_close_at, draw_at, claim_window_days, created_by,
                           prize_share_bp, instant_share_bp, max_tickets_per_day, levels)
       VALUES ($1, 'SIMULATED', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING id`,
      [input.name, input.ticketPriceKobo, input.totalTickets, input.maxTicketsPerAccount,
        input.salesOpenAt, input.salesCloseAt, input.drawAt, input.claimWindowDays ?? 90, admin.id,
        policy.prizeShareBp, policy.instantShareBp, policy.cardsPerDay, levels]).catch(asConflict);
    await audit(db, adminActor(admin), "cycle.created", "cycle", r.rows[0]!.id, { ...input });
    return { id: r.rows[0]!.id };
  });
}

export interface NewTier {
  stage: "INSTANT" | "FINAL_DRAW"; kind: "CASH" | "MERCHANDISE"; title: string;
  cashKobo?: number; skuId?: string; quantity: number; drawOrder?: number;
}

export async function addPrizeTier(ctx: Ctx, admin: Admin, cycleId: string, t: NewTier): Promise<{ id: string }> {
  requireRole(admin, "CYCLE_MANAGER");
  if (t.kind === "CASH" && !t.cashKobo) throw badRequest("INVALID_PRIZE", "Enter the cash amount.");
  if (t.kind === "MERCHANDISE" && !t.skuId) throw badRequest("INVALID_PRIZE", "Choose the merchandise item.");
  if (t.stage === "FINAL_DRAW" && !t.drawOrder) throw badRequest("INVALID_PRIZE", "Give the draw order for a final-draw prize.");
  if (t.stage === "INSTANT" && (t.kind !== "CASH" || t.cashKobo! < 50_000 || t.cashKobo! > 1_000_000)) {
    throw badRequest("INVALID_PRIZE", "Instant prizes must be cash between ₦500 and ₦10,000.");
  }
  const outcomeCode = t.kind === "CASH" ? `CASH:${t.cashKobo}` : `SKU:${t.skuId}`;
  return withTx(ctx.pool, async (db) => {
    const r = await db.query<{ id: string }>(
      `INSERT INTO prize_tiers (cycle_id, stage, kind, outcome_code, title, cash_kobo, sku_id, quantity, draw_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [cycleId, t.stage, t.kind, t.stage === "FINAL_DRAW" ? `DRAW:${t.drawOrder}:${outcomeCode}` : outcomeCode,
        t.title, t.cashKobo ?? null, t.skuId ?? null, t.quantity, t.drawOrder ?? null]).catch(asConflict);
    await audit(db, adminActor(admin), "cycle.prize_tier_added", "cycle", cycleId, { ...t });
    return { id: r.rows[0]!.id };
  });
}

export interface Evidence {
  financialModelRef: string; rulesDocumentRef: string; rulesText: string;
  escrowReference: string; escrowFundedKobo: number; auditorAdminId: string;
}

export async function setEvidence(ctx: Ctx, admin: Admin, cycleId: string, e: Evidence): Promise<void> {
  requireRole(admin, "CYCLE_MANAGER", "FINANCE");
  await withTx(ctx.pool, async (db) => {
    const auditor = await one(db, "SELECT 1 FROM admin_roles WHERE admin_user_id = $1 AND role = 'AUDITOR'", [e.auditorAdminId]);
    if (!auditor) throw badRequest("NOT_AN_AUDITOR", "The appointed auditor must hold the auditor role.");
    await db.query(
      `UPDATE cycles SET financial_model_ref = $2, rules_document_ref = $3, rules_sha256 = $4, rules_text = $8,
                         escrow_reference = $5, escrow_funded_kobo = $6, auditor_admin_id = $7 WHERE id = $1`,
      [cycleId, e.financialModelRef, e.rulesDocumentRef, sha256(e.rulesText), e.escrowReference, e.escrowFundedKobo, e.auditorAdminId, e.rulesText]).catch(asConflict);
    await audit(db, adminActor(admin), "cycle.evidence_set", "cycle", cycleId,
      { financialModelRef: e.financialModelRef, escrowReference: e.escrowReference, escrowFundedKobo: e.escrowFundedKobo, auditorAdminId: e.auditorAdminId });
  });
}

/**
 * The prize budget: prizes are paid from a fixed share of what full sell-out
 * would bring in, and a fixed share of that goes to instant cash wins (company
 * policy, fixed on the cycle when drafted). Merchandise counts at its
 * advertised value. Both shares are ceilings.
 */
export interface PrizeBudget {
  fullSalesKobo: number; poolKobo: number; instantBudgetKobo: number; drawBudgetKobo: number;
  instantKobo: number; drawKobo: number; prizeShareBp: number; instantShareBp: number;
}
export async function prizeBudget(db: Db | Ctx["pool"], cycleId: string): Promise<PrizeBudget> {
  const c = await getCycle(db, cycleId);
  const t = await one<{ instant: number; draw: number }>(db,
    `SELECT coalesce(sum(CASE WHEN p.stage = 'INSTANT' THEN coalesce(p.cash_kobo, s.advertised_value_kobo) * p.quantity END), 0)::bigint AS instant,
            coalesce(sum(CASE WHEN p.stage = 'FINAL_DRAW' THEN coalesce(p.cash_kobo, s.advertised_value_kobo) * p.quantity END), 0)::bigint AS draw
     FROM prize_tiers p LEFT JOIN skus s ON s.id = p.sku_id WHERE p.cycle_id = $1`, [cycleId]);
  const fullSalesKobo = c.total_tickets * Number(c.ticket_price_kobo);
  const poolKobo = share(fullSalesKobo, c.prize_share_bp);
  const instantBudgetKobo = share(poolKobo, c.instant_share_bp);
  // The instant share is a ceiling on instant cash; whatever of the prize money instant cash does not use is
  // available to the final draw (the SRS campaign: ₦20m instant, ₦651.5m final draw, ₦671.5m in all).
  return { fullSalesKobo, poolKobo, instantBudgetKobo, drawBudgetKobo: poolKobo - Math.min(Number(t!.instant), instantBudgetKobo),
    instantKobo: Number(t!.instant), drawKobo: Number(t!.draw), prizeShareBp: c.prize_share_bp, instantShareBp: c.instant_share_bp };
}

const nairaText = (k: number) => "₦" + (k / 100).toLocaleString("en-NG");

export async function submitCycle(ctx: Ctx, admin: Admin, cycleId: string): Promise<void> {
  requireRole(admin, "CYCLE_MANAGER");
  await withTx(ctx.pool, async (db) => {
    await db.query("UPDATE cycles SET status = 'SUBMITTED' WHERE id = $1", [cycleId]).catch(asConflict);
    await audit(db, adminActor(admin), "cycle.submitted", "cycle", cycleId);
  });
}

/**
 * Records one approval. Finance approves as FINANCE; a cycle manager or
 * compliance officer (not the drafter) approves as OPERATIONS. When both are
 * in, the cycle becomes APPROVED and is locked — the database checks the
 * evidence and the escrow funding at that moment.
 */
export async function approveCycle(ctx: Ctx, admin: Admin, cycleId: string): Promise<{ status: string }> {
  requireRole(admin, "FINANCE", "CYCLE_MANAGER", "COMPLIANCE");
  const capacity = admin.roles.includes("FINANCE") ? "FINANCE" : "OPERATIONS";
  return withTx(ctx.pool, async (db) => {
    await db.query("INSERT INTO cycle_approvals (cycle_id, approver_id, capacity) VALUES ($1, $2, $3)", [cycleId, admin.id, capacity]).catch(asConflict);
    await audit(db, adminActor(admin), "cycle.approval_recorded", "cycle", cycleId, { capacity });
    const n = await one<{ n: number }>(db, "SELECT count(*)::int AS n FROM cycle_approvals WHERE cycle_id = $1", [cycleId]);
    if (n!.n < 2) return { status: "SUBMITTED" };
    // Checked again by the database; done here first to give a message in naira.
    const cover = await one<{ need: number; have: number | null }>(db,
      `SELECT coalesce((SELECT sum(cash_kobo * quantity) FROM prize_tiers WHERE cycle_id = c.id AND kind = 'CASH'), 0)::bigint AS need, c.escrow_funded_kobo AS have
       FROM cycles c WHERE c.id = $1`, [cycleId]);
    if (cover && cover.have !== null && cover.have < cover.need) {
      const n2 = (k: number) => "₦" + (k / 100).toLocaleString("en-NG");
      throw conflict("RULE_VIOLATION", `Cash prizes total ${n2(cover.need)} but only ${n2(cover.have)} is recorded in escrow. They must be fully funded before approval.`);
    }
    const b = await prizeBudget(db, cycleId);
    if (b.instantKobo > b.instantBudgetKobo) {
      throw conflict("PRIZE_BUDGET", `Instant cash prizes total ${nairaText(b.instantKobo)}, above the ${nairaText(b.instantBudgetKobo)} allowed (${b.instantShareBp / 100}% of the ${nairaText(b.poolKobo)} prize money).`);
    }
    if (b.drawKobo > b.drawBudgetKobo) {
      throw conflict("PRIZE_BUDGET", `Prizes total ${nairaText(b.instantKobo + b.drawKobo)}, above the ${nairaText(b.poolKobo)} prize money (${b.prizeShareBp / 100}% of ${nairaText(b.fullSalesKobo)} full sell-out sales).`);
    }
    await db.query("UPDATE cycles SET status = 'APPROVED' WHERE id = $1", [cycleId]).catch(asConflict);
    await audit(db, adminActor(admin), "cycle.approved", "cycle", cycleId);
    return { status: "APPROVED" };
  });
}

// --- Commit: generate the fixed inventory and publish the commitments ---------------

const SERIAL_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // 32 symbols, no look-alikes

/**
 * Serial numbers, unique by construction rather than by remembering every one
 * issued (which for 10 million cards would take gigabytes): card i gets the
 * 50-bit number (a·i + b) mod 2^50, with a odd and a, b random per cycle —
 * a permutation, so no two cards share a serial. Serials are labels, not
 * secrets (the card's position is published in its proof anyway).
 */
function serialMaker(): (i: number) => string {
  const MASK = (1n << 50n) - 1n;
  const a = (BigInt("0x" + randomBytes(7).toString("hex")) & MASK) | 1n;
  const b = BigInt("0x" + randomBytes(7).toString("hex")) & MASK;
  return (i: number) => {
    let n = (a * BigInt(i) + b) & MASK;
    let out = "";
    for (let k = 0; k < 10; k++) { out = SERIAL_ALPHABET[Number(n & 31n)] + out; n >>= 5n; }
    return `WR-${out.slice(0, 5)}-${out.slice(5)}`;
  };
}

/** Associated data that binds an encrypted outcome to its own ticket, so ciphertexts cannot be swapped between tickets. */
export const ticketAad = (cycleId: string, serial: string): string => `ticket:${cycleId}:${serial}`;
export const cycleKeyContext = (cycleId: string): string => `cycle:${cycleId}`;

export async function commitCycle(ctx: Ctx, admin: Admin, cycleId: string): Promise<{ merkleRoot: string; tickets: number }> {
  requireRole(admin, "CYCLE_MANAGER");
  return withTx(ctx.pool, async (db) => {
    const cycle = await getCycle(db, cycleId, true);
    if (cycle.status !== "APPROVED") throw conflict("NOT_APPROVED", "Only an approved cycle can be committed.");

    const tiers = await db.query<{ outcome_code: string; quantity: number; stage: string; title: string; cash_kobo: number | null; draw_order: number | null }>(
      "SELECT outcome_code, quantity, stage, title, cash_kobo, draw_order FROM prize_tiers WHERE cycle_id = $1 ORDER BY stage, draw_order NULLS FIRST, outcome_code", [cycleId]);
    const instant = tiers.rows.filter((t) => t.stage === "INSTANT").map((t) => ({ outcome: t.outcome_code, count: t.quantity }));

    // The generation seed is used once and never stored: the published
    // commitment, not the seed, is what fixes the outcomes. Each level gets its
    // own share of every instant prize (spread as evenly as whole prizes allow),
    // shuffled within the level, so instant cash is released level by level.
    // Cards are made and stored a chunk at a time, keeping only the 32-byte
    // leaf hashes in one buffer, so a campaign of 10 million cards fits in memory.
    const L = cycle.levels, total = cycle.total_tickets, size = total / L;
    const dataKey = randomBytes(32);
    const serialAt = serialMaker();
    const leaves = Buffer.allocUnsafe(total * 32);
    const CHUNK = 20_000;
    for (let level = 0; level < L; level++) {
      const share = instant.map((t) => ({ outcome: t.outcome, count: levelShare(t.count, L, level) }));
      const outcomes = generateOutcomes(size, share, randomBytes(32));
      for (let from = 0; from < size; from += CHUNK) {
        const to = Math.min(size, from + CHUNK);
        const salts = randomBytes(16 * (to - from));
        const serials: string[] = [], indexes: number[] = [], chunkLeaves: Buffer[] = [], ciphertexts: Buffer[] = [];
        for (let j = from; j < to; j++) {
          const i = level * size + j, serial = serialAt(i), outcome = outcomes[j]!;
          const salt = salts.subarray((j - from) * 16, (j - from + 1) * 16);
          const leaf = ticketLeafHash({ cycleId, serial, outcome, salt });
          leaf.copy(leaves, i * 32);
          serials.push(serial); indexes.push(i); chunkLeaves.push(leaf);
          ciphertexts.push(seal(dataKey, Buffer.from(JSON.stringify({ o: outcome, s: salt.toString("hex") })), ticketAad(cycleId, serial)));
        }
        await db.query(
          `INSERT INTO tickets (cycle_id, serial, leaf_index, leaf_hash, outcome_ciphertext)
           SELECT $1, * FROM unnest($2::text[], $3::int[], $4::bytea[], $5::bytea[])`,
          [cycleId, serials, indexes, chunkLeaves, ciphertexts]);
      }
    }
    const root = new PackedMerkleTree(leaves, total).root;

    const drawSecret = randomBytes(32);
    const beaconRound = ctx.beacon.roundAfter(cycle.draw_at);
    await db.query(
      `INSERT INTO cycle_secrets (cycle_id, wrapped_data_key, draw_secret_ciphertext, beacon_source, beacon_round) VALUES ($1, $2, $3, $4, $5)`,
      [cycleId, await ctx.keys.wrap(dataKey, cycleKeyContext(cycleId)), seal(dataKey, drawSecret, `draw-secret:${cycleId}`), ctx.beacon.source, beaconRound]);
    dataKey.fill(0);

    // With levels, how the prizes are spread across them is part of what is published.
    const prizeTableHash = sha256(JSON.stringify(L > 1 ? { levels: L, tiers: tiers.rows } : tiers.rows));
    await db.query(
      `INSERT INTO cycle_commitments (cycle_id, game_core_version, ticket_merkle_root, prize_table_sha256, draw_secret_commitment, kms_key_ref)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [cycleId, GAME_CORE_VERSION, root, prizeTableHash, commitSecret(drawSecret), ctx.keys.ref]);
    await db.query("UPDATE cycles SET status = 'COMMITTED' WHERE id = $1", [cycleId]).catch(asConflict);
    await audit(db, adminActor(admin), "cycle.committed", "cycle", cycleId,
      { tickets: cycle.total_tickets, merkleRoot: root.toString("hex"), beaconRound });
    return { merkleRoot: root.toString("hex"), tickets: cycle.total_tickets };
  });
}

/** How many of a prize tier's `count` prizes go into level `i` of `levels` (the first levels take any remainder). */
export const levelShare = (count: number, levels: number, i: number): number => Math.floor(count / levels) + (i < count % levels ? 1 : 0);

export async function openCycle(ctx: Ctx, admin: Admin, cycleId: string): Promise<void> {
  requireRole(admin, "CYCLE_MANAGER");
  await withTx(ctx.pool, async (db) => {
    const cycle = await getCycle(db, cycleId, true);
    if (cycle.sales_open_at.getTime() > Date.now()) throw conflict("TOO_EARLY", "Sales cannot open before the approved opening time.");
    if (cycle.sales_close_at.getTime() <= Date.now()) throw conflict("TOO_LATE", "The approved closing time has already passed.");
    // The database refuses this for a real-money cycle without a licence and certification.
    await db.query("UPDATE cycles SET status = 'OPEN' WHERE id = $1", [cycleId]).catch(asConflict);
    await audit(db, adminActor(admin), "cycle.opened", "cycle", cycleId);
  });
}

// --- Closing: sold out, or the published closing time, whichever is first -----------

export async function closeIfDue(db: Db, cycleId: string, actor: Actor = SYSTEM): Promise<boolean> {
  const cycle = await getCycle(db, cycleId, true);
  if (cycle.status !== "OPEN") return false;
  const timeUp = cycle.sales_close_at.getTime() <= Date.now();
  // Called after every sale: a cheap existence check first, the full count only when closing.
  // Cards held for a payment in progress are not sold yet: the cycle stays open until they are paid for or released.
  const soldOut = !(await one(db, "SELECT 1 FROM tickets WHERE cycle_id = $1 AND status IN ('UNSOLD','RESERVED') LIMIT 1", [cycleId]));
  if (!soldOut && !timeUp) return false;
  const unsold = await one<{ n: number }>(db, "SELECT count(*)::int AS n FROM tickets WHERE cycle_id = $1 AND status = 'UNSOLD'", [cycleId]);
  await db.query("UPDATE cycles SET status = 'CLOSED' WHERE id = $1", [cycleId]);
  await audit(db, actor, "cycle.closed", "cycle", cycleId, { reason: soldOut ? "SOLD_OUT" : "CLOSING_TIME", unsold: unsold!.n });
  return true;
}

/** Run periodically: closes every open cycle that has sold out or reached its closing time. */
export async function closeDueCycles(ctx: Ctx): Promise<string[]> {
  const due = await ctx.pool.query<{ id: string }>(
    `SELECT c.id FROM cycles c WHERE c.status = 'OPEN'
       AND (c.sales_close_at <= now() OR NOT EXISTS (SELECT 1 FROM tickets t WHERE t.cycle_id = c.id AND t.status IN ('UNSOLD','RESERVED')))`);
  const closed: string[] = [];
  for (const { id } of due.rows) {
    if (await withTx(ctx.pool, (db) => closeIfDue(db, id))) closed.push(id);
  }
  return closed;
}

// --- Public catalogue ------------------------------------------------------------------

/**
 * Cards left in a cycle. Counting 400,000 rows on every page view would be
 * wasteful during a rush, so the figure is reused for two seconds.
 */
const remainingCache = new Map<string, { n: number; at: number }>();
export async function ticketsRemaining(db: Db | Ctx["pool"], cycleId: string): Promise<number> {
  const hit = remainingCache.get(cycleId);
  if (hit && Date.now() - hit.at < 2000) return hit.n;
  const n = (await one<{ n: number }>(db, "SELECT coalesce(sum(unsold), 0)::int AS n FROM cycle_unsold WHERE cycle_id = $1", [cycleId]))!.n;
  if (remainingCache.size > 50) remainingCache.clear();
  remainingCache.set(cycleId, { n, at: Date.now() });
  return n;
}

/**
 * Which level is on sale and how many of its cards are left, with the instant
 * cash it holds. Reused for two seconds, like the remaining count.
 */
const levelCache = new Map<string, { at: number; value: unknown }>();
export async function levelStatus(db: Db | Ctx["pool"], cycleId: string): Promise<unknown> {
  const hit = levelCache.get(cycleId);
  if (hit && Date.now() - hit.at < 2000) return hit.value;
  const c = await getCycle(db, cycleId);
  const size = c.total_tickets / c.levels;
  const on = await one<{ level: number; unsold: number }>(db, "SELECT level, unsold FROM cycle_unsold WHERE cycle_id = $1 AND unsold > 0 ORDER BY level LIMIT 1", [cycleId]);
  const index = on ? on.level : c.levels - 1;
  const left = on ? on.unsold : 0;
  const tiers = await db.query<{ cash_kobo: number; quantity: number }>("SELECT cash_kobo, quantity FROM prize_tiers WHERE cycle_id = $1 AND stage = 'INSTANT'", [cycleId]);
  const cashIn = (i: number) => tiers.rows.reduce((s, t) => s + Number(t.cash_kobo) * levelShare(t.quantity, c.levels, i), 0);
  const value = { levels: c.levels, size, current: index + 1, leftInLevel: left, instantCashInLevelKobo: cashIn(index) };
  if (levelCache.size > 50) levelCache.clear();
  levelCache.set(cycleId, { at: Date.now(), value });
  return value;
}

export async function listPublicCycles(ctx: Ctx): Promise<unknown[]> {
  const r = await ctx.pool.query<{ id: string; tickets_remaining: number }>(
    `SELECT c.id, c.name, c.status, c.mode, c.state_code, c.ticket_price_kobo, c.total_tickets, c.max_tickets_per_account, c.max_tickets_per_day,
            c.sales_open_at, c.sales_close_at, c.draw_at, c.claim_window_days
     FROM cycles c WHERE c.status IN ('COMMITTED','OPEN','CLOSED','DRAWN','SETTLING','ARCHIVED') OR (c.status = 'VOID' AND EXISTS (SELECT 1 FROM cycle_commitments cc WHERE cc.cycle_id = c.id))
     ORDER BY c.sales_open_at DESC`);
  for (const row of r.rows) row.tickets_remaining = await ticketsRemaining(ctx.pool, row.id);
  return r.rows;
}

export async function getPublicCycle(ctx: Ctx, cycleId: string): Promise<unknown> {
  const c = await one<Record<string, unknown> & { total_tickets: number }>(
    ctx.pool,
    `SELECT c.id, c.name, c.status, c.mode, c.state_code, c.ticket_price_kobo, c.total_tickets, c.max_tickets_per_account, c.max_tickets_per_day,
            c.sales_open_at, c.sales_close_at, c.draw_at, c.claim_window_days, c.rules_document_ref, encode(c.rules_sha256, 'hex') AS rules_sha256,
            c.prize_share_bp, c.instant_share_bp
     FROM cycles c WHERE c.id = $1 AND (c.status IN ('COMMITTED','OPEN','CLOSED','DRAWN','SETTLING','ARCHIVED') OR (c.status = 'VOID' AND EXISTS (SELECT 1 FROM cycle_commitments cc WHERE cc.cycle_id = c.id)))`, [cycleId]);
  if (!c) throw notFound("Cycle not found.");
  c.tickets_remaining = await ticketsRemaining(ctx.pool, cycleId);
  const tiers = await ctx.pool.query<{ stage: string; kind: string; title: string; cash_kobo: number | null; quantity: number; draw_order: number | null }>(
    `SELECT p.id, p.stage, p.kind, p.title, p.cash_kobo, p.quantity, p.draw_order, EXISTS (SELECT 1 FROM prize_images i WHERE i.prize_tier_id = p.id) AS has_image
     FROM prize_tiers p WHERE p.cycle_id = $1 ORDER BY p.stage DESC, p.draw_order NULLS LAST, p.cash_kobo DESC`, [cycleId]);
  const commitment = await one(
    ctx.pool,
    `SELECT cc.game_core_version, encode(cc.ticket_merkle_root, 'hex') AS ticket_merkle_root, encode(cc.prize_table_sha256, 'hex') AS prize_table_sha256,
            encode(cc.draw_secret_commitment, 'hex') AS draw_secret_commitment, cc.published_at, cs.beacon_source, cs.beacon_round
     FROM cycle_commitments cc JOIN cycle_secrets cs ON cs.cycle_id = cc.cycle_id WHERE cc.cycle_id = $1`, [cycleId]);
  const instantWinners = tiers.rows.filter((t) => t.stage === "INSTANT").reduce((n, t) => n + t.quantity, 0);
  return {
    ...c,
    prizes: tiers.rows,
    // Stated plainly for players: how many of the cards issued carry an instant prize.
    instantWinOdds: instantWinners ? { winners: instantWinners, outOf: c.total_tickets } : null,
    commitment,
  };
}

// --- Game rules: published, versioned, accepted by each player (SRS REG-007, WEB-012) ---------------

/**
 * A campaign's approved game rules, with the probabilities players must be
 * shown: each instant prize's chance per card, and the final draw's prizes and
 * the chance of a card winning one at full sales (each card can win at most one
 * final-draw prize; a player with several cards can win more than one).
 */
export async function gameRules(ctx: Ctx, cycleId: string): Promise<unknown> {
  const c = await one<{ name: string; total_tickets: number; ticket_price_kobo: number; rules_text: string | null; rules_sha256: Buffer | null; status: string; draw_at: Date; claim_window_days: number }>(ctx.pool,
    "SELECT name, total_tickets, ticket_price_kobo, rules_text, rules_sha256, status, draw_at, claim_window_days FROM cycles WHERE id = $1 AND status NOT IN ('DRAFT','SUBMITTED','APPROVED')", [cycleId]);
  if (!c) throw notFound("Cycle not found.");
  const tiers = (await ctx.pool.query<{ stage: string; title: string; cash_kobo: number | null; quantity: number }>(
    "SELECT stage, title, cash_kobo, quantity FROM prize_tiers WHERE cycle_id = $1 ORDER BY stage DESC, draw_order NULLS LAST, cash_kobo DESC", [cycleId])).rows;
  const instant = tiers.filter((t) => t.stage === "INSTANT");
  const draw = tiers.filter((t) => t.stage === "FINAL_DRAW");
  const odds = (n: number) => (n ? Math.round(c.total_tickets / n) : null);
  const instantWinners = instant.reduce((s, t) => s + t.quantity, 0), drawPrizes = draw.reduce((s, t) => s + t.quantity, 0);
  return {
    name: c.name, text: c.rules_text, sha256: c.rules_sha256?.toString("hex") ?? null, version: c.rules_sha256?.toString("hex").slice(0, 12) ?? null,
    totalCards: c.total_tickets, priceKobo: Number(c.ticket_price_kobo), drawAt: c.draw_at, claimWindowDays: c.claim_window_days,
    instant: instant.map((t) => ({ cashKobo: Number(t.cash_kobo), winners: t.quantity, oneIn: odds(t.quantity) })),
    instantOneIn: odds(instantWinners), instantWinners,
    finalDraw: draw.map((t) => ({ title: t.title, quantity: t.quantity })), finalDrawPrizes: drawPrizes,
    finalDrawPercentAtFullSales: Math.round((drawPrizes / c.total_tickets) * 100_000) / 1000,
  };
}

/** Whether the player has accepted this campaign's current rules (true when it has no published rules text). */
export async function rulesAccepted(db: Db | Ctx["pool"], userId: string, cycle: { id: string; rules_sha256?: Buffer | null }): Promise<boolean> {
  const sha = cycle.rules_sha256 ?? (await one<{ rules_sha256: Buffer | null }>(db, "SELECT rules_sha256 FROM cycles WHERE id = $1", [cycle.id]))?.rules_sha256;
  if (!sha) return true;
  return Boolean(await one(db, "SELECT 1 FROM rule_acceptances WHERE user_id = $1 AND cycle_id = $2 AND rules_sha256 = $3", [userId, cycle.id, sha]));
}

export async function acceptRules(ctx: Ctx, actor: Actor, userId: string, cycleId: string): Promise<{ version: string }> {
  return withTx(ctx.pool, async (db) => {
    const c = await one<{ rules_sha256: Buffer | null }>(db, "SELECT rules_sha256 FROM cycles WHERE id = $1 AND status NOT IN ('DRAFT','SUBMITTED','APPROVED')", [cycleId]);
    if (!c?.rules_sha256) throw notFound("Cycle not found.");
    const r = await db.query("INSERT INTO rule_acceptances (user_id, cycle_id, rules_sha256, ip) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING",
      [userId, cycleId, c.rules_sha256, actor.ip ?? null]);
    if (r.rowCount) await audit(db, actor, "player.rules_accepted", "cycle", cycleId, { version: c.rules_sha256.toString("hex").slice(0, 12) });
    return { version: c.rules_sha256.toString("hex").slice(0, 12) };
  });
}

export function assertSimulated(cycle: CycleRow): void {
  if (cycle.mode !== "SIMULATED") throw new AppError(403, "REAL_MONEY_DISABLED", "Real-money play is not enabled.");
}

// --- Read models for the admin web app -----------------------------------------------------

export async function listAdminCycles(ctx: Ctx, admin: Admin): Promise<unknown[]> {
  if (!admin.roles.length) throw notFound();
  return (await ctx.pool.query(
    `SELECT c.id, c.name, c.status, c.mode, c.ticket_price_kobo, c.total_tickets, c.sales_open_at, c.sales_close_at, c.draw_at,
            (SELECT count(*) FROM tickets t WHERE t.cycle_id = c.id AND t.status IN ('SOLD','REVEALED'))::int AS sold,
            (SELECT count(*) FROM cycle_approvals a WHERE a.cycle_id = c.id)::int AS approvals,
            EXISTS (SELECT 1 FROM cycle_void_requests v WHERE v.cycle_id = c.id AND v.status = 'PENDING') AS void_pending
     FROM cycles c ORDER BY c.created_at DESC`)).rows;
}

/** Everything the admin screens show for one cycle. Never includes ticket outcomes. */
export async function getAdminCycle(ctx: Ctx, admin: Admin, cycleId: string): Promise<unknown> {
  if (!admin.roles.length) throw notFound();
  const c = await one<Record<string, unknown> & { status: string; draw_at: Date; total_tickets: number }>(
    ctx.pool,
    `SELECT c.id, c.name, c.status, c.mode, c.state_code, c.ticket_price_kobo, c.total_tickets, c.max_tickets_per_account, c.max_tickets_per_day, c.levels,
            c.sales_open_at, c.sales_close_at, c.draw_at, c.claim_window_days, c.financial_model_ref, c.rules_document_ref,
            encode(c.rules_sha256, 'hex') AS rules_sha256, c.escrow_reference, c.escrow_funded_kobo,
            c.auditor_admin_id, au.full_name AS auditor_name, c.created_by, cb.full_name AS created_by_name,
            c.archive_requested_by, ar.full_name AS archive_requested_by_name, c.archive_requested_at, ab.full_name AS archived_by_name, c.archived_at
     FROM cycles c JOIN admin_users cb ON cb.id = c.created_by LEFT JOIN admin_users au ON au.id = c.auditor_admin_id
     LEFT JOIN admin_users ar ON ar.id = c.archive_requested_by LEFT JOIN admin_users ab ON ab.id = c.archived_by
     WHERE c.id = $1`, [cycleId]);
  if (!c) throw notFound("Cycle not found.");
  const q = (sql: string) => ctx.pool.query(sql, [cycleId]).then((r) => r.rows);
  const [tiers, approvals, signoffs, commitment, counts, drawn] = await Promise.all([
    q(`SELECT p.id, p.stage, p.kind, p.title, p.cash_kobo, p.quantity, p.draw_order, s.name AS sku_name,
              EXISTS (SELECT 1 FROM prize_images i WHERE i.prize_tier_id = p.id) AS has_image,
              (SELECT count(*) FROM prize_claims pc WHERE pc.prize_tier_id = p.id)::int AS awarded
       FROM prize_tiers p LEFT JOIN skus s ON s.id = p.sku_id WHERE p.cycle_id = $1 ORDER BY p.stage DESC, p.draw_order NULLS LAST, p.cash_kobo DESC`),
    q(`SELECT a.capacity, a.approved_at, a.approver_id, u.full_name FROM cycle_approvals a JOIN admin_users u ON u.id = a.approver_id WHERE a.cycle_id = $1 ORDER BY a.approved_at`),
    q(`SELECT s.capacity, s.signed_at, s.admin_user_id, u.full_name FROM draw_signoffs s JOIN admin_users u ON u.id = s.admin_user_id WHERE s.cycle_id = $1 ORDER BY s.signed_at`),
    q(`SELECT cc.game_core_version, encode(cc.ticket_merkle_root, 'hex') AS ticket_merkle_root, encode(cc.prize_table_sha256, 'hex') AS prize_table_sha256,
              encode(cc.draw_secret_commitment, 'hex') AS draw_secret_commitment, cc.published_at, cs.beacon_source, cs.beacon_round
       FROM cycle_commitments cc JOIN cycle_secrets cs ON cs.cycle_id = cc.cycle_id WHERE cc.cycle_id = $1`),
    q(`SELECT count(*) FILTER (WHERE status IN ('SOLD','REVEALED'))::int AS sold, count(*) FILTER (WHERE status = 'REVEALED')::int AS revealed,
              count(*) FILTER (WHERE status = 'UNSOLD')::int AS unsold FROM tickets WHERE cycle_id = $1`),
    q(`SELECT executed_at, entries_count FROM draws WHERE cycle_id = $1`),
  ]);
  const budget = await prizeBudget(ctx.pool, cycleId);
  const cashCover = (tiers as { kind: string; cash_kobo: number | null; quantity: number }[]).reduce((s, t) => s + (t.kind === "CASH" ? t.cash_kobo! * t.quantity : 0), 0);
  return {
    ...c, tiers, approvals, signoffs, commitment: commitment[0] ?? null, counts: counts[0], draw: drawn[0] ?? null,
    cashCoverRequiredKobo: cashCover,
    budget,
    // Levels are an operating detail shown to staff only; players are not shown them.
    level: await levelStatus(ctx.pool, cycleId),
    stockCover: await stockCover(ctx, cycleId),
    voidRequests: (await ctx.pool.query(
      `SELECT v.id, v.reason, v.status, v.requested_at, v.requested_by, rq.full_name AS requested_by_name, v.decided_at, dc.full_name AS decided_by_name, v.decision_reason
       FROM cycle_void_requests v JOIN admin_users rq ON rq.id = v.requested_by LEFT JOIN admin_users dc ON dc.id = v.decided_by
       WHERE v.cycle_id = $1 ORDER BY v.requested_at DESC`, [cycleId])).rows,
    refunds: (await one<{ n: number; kobo: number }>(ctx.pool,
      "SELECT count(*)::int AS n, coalesce(sum(rf.amount_kobo), 0)::bigint AS kobo FROM refunds rf JOIN orders o ON o.id = rf.order_id WHERE o.cycle_id = $1 AND rf.status = 'CONFIRMED'", [cycleId]))!,
    drawTimeReached: c.draw_at.getTime() <= Date.now(),
    editable: c.status === "DRAFT" || c.status === "SUBMITTED",
  };
}
