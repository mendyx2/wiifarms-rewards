import { randomBytes } from "node:crypto";
import { MerkleTree, commitSecret, generateOutcomes, ticketLeafHash } from "@wiifarm/game-core";
import { SYSTEM, audit, type Actor } from "../audit.ts";
import type { Ctx } from "../context.ts";
import { seal, sha256 } from "../crypto.ts";
import { one, withTx, type Db } from "../db.ts";
import { AppError, badRequest, conflict, notFound } from "../errors.ts";
import { adminActor, requireRole, type Admin } from "./admin.ts";

/** Identifies the exact engine build that generated a cycle; certification is recorded against it. */
export const GAME_CORE_VERSION = "game-core@0.1.0";

export interface CycleRow {
  id: string; name: string; mode: string; state_code: string; status: string;
  ticket_price_kobo: number; total_tickets: number; max_tickets_per_account: number;
  sales_open_at: Date; sales_close_at: Date; draw_at: Date; claim_window_days: number;
  rules_document_ref: string | null; auditor_admin_id: string | null; created_by: string;
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
  if (e.code === "23000" || e.code === "23514" || e.code === "23505") throw conflict("RULE_VIOLATION", e.message ?? "Not allowed.");
  throw err;
}

// --- Drafting ---------------------------------------------------------------------

export interface NewCycle {
  name: string; ticketPriceKobo: number; totalTickets: number; maxTicketsPerAccount: number;
  salesOpenAt: string; salesCloseAt: string; drawAt: string; claimWindowDays?: number;
}

export async function createCycle(ctx: Ctx, admin: Admin, input: NewCycle): Promise<{ id: string }> {
  requireRole(admin, "CYCLE_MANAGER");
  // Brief section 2: tickets are initially priced between ₦200 and ₦500.
  if (input.ticketPriceKobo < 20_000 || input.ticketPriceKobo > 50_000) {
    throw badRequest("INVALID_PRICE", "Ticket price must be between ₦200 and ₦500.");
  }
  return withTx(ctx.pool, async (db) => {
    // Every cycle is SIMULATED in Phase 2. Real-money cycles cannot be created through this API at all.
    const r = await db.query<{ id: string }>(
      `INSERT INTO cycles (name, mode, ticket_price_kobo, total_tickets, max_tickets_per_account,
                           sales_open_at, sales_close_at, draw_at, claim_window_days, created_by)
       VALUES ($1, 'SIMULATED', $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [input.name, input.ticketPriceKobo, input.totalTickets, input.maxTicketsPerAccount,
        input.salesOpenAt, input.salesCloseAt, input.drawAt, input.claimWindowDays ?? 90, admin.id]).catch(asConflict);
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
      `UPDATE cycles SET financial_model_ref = $2, rules_document_ref = $3, rules_sha256 = $4,
                         escrow_reference = $5, escrow_funded_kobo = $6, auditor_admin_id = $7 WHERE id = $1`,
      [cycleId, e.financialModelRef, e.rulesDocumentRef, sha256(e.rulesText), e.escrowReference, e.escrowFundedKobo, e.auditorAdminId]).catch(asConflict);
    await audit(db, adminActor(admin), "cycle.evidence_set", "cycle", cycleId,
      { financialModelRef: e.financialModelRef, escrowReference: e.escrowReference, escrowFundedKobo: e.escrowFundedKobo, auditorAdminId: e.auditorAdminId });
  });
}

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
    await db.query("UPDATE cycles SET status = 'APPROVED' WHERE id = $1", [cycleId]).catch(asConflict);
    await audit(db, adminActor(admin), "cycle.approved", "cycle", cycleId);
    return { status: "APPROVED" };
  });
}

// --- Commit: generate the fixed inventory and publish the commitments ---------------

const SERIAL_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // 32 symbols, no look-alikes

function newSerial(): string {
  const b = randomBytes(10);
  let s = "";
  for (let i = 0; i < 10; i++) s += SERIAL_ALPHABET[b[i]! & 31];
  return `WR-${s.slice(0, 5)}-${s.slice(5)}`;
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
    // commitment, not the seed, is what fixes the outcomes.
    const outcomes = generateOutcomes(cycle.total_tickets, instant, randomBytes(32));

    const dataKey = randomBytes(32);
    const serials = new Set<string>();
    while (serials.size < cycle.total_tickets) serials.add(newSerial());
    const serialList = [...serials];

    const leaves: Buffer[] = [];
    const ciphertexts: Buffer[] = [];
    for (let i = 0; i < cycle.total_tickets; i++) {
      const serial = serialList[i]!, outcome = outcomes[i]!, salt = randomBytes(16);
      leaves.push(ticketLeafHash({ cycleId, serial, outcome, salt }));
      ciphertexts.push(seal(dataKey, Buffer.from(JSON.stringify({ o: outcome, s: salt.toString("hex") })), ticketAad(cycleId, serial)));
    }
    const root = new MerkleTree(leaves).root;

    await db.query(
      `INSERT INTO tickets (cycle_id, serial, leaf_index, leaf_hash, outcome_ciphertext)
       SELECT $1, * FROM unnest($2::text[], $3::int[], $4::bytea[], $5::bytea[])`,
      [cycleId, serialList, serialList.map((_, i) => i), leaves, ciphertexts]);

    const drawSecret = randomBytes(32);
    const beaconRound = ctx.beacon.roundAfter(cycle.draw_at);
    await db.query(
      `INSERT INTO cycle_secrets (cycle_id, wrapped_data_key, draw_secret_ciphertext, beacon_source, beacon_round) VALUES ($1, $2, $3, $4, $5)`,
      [cycleId, await ctx.keys.wrap(dataKey, cycleKeyContext(cycleId)), seal(dataKey, drawSecret, `draw-secret:${cycleId}`), ctx.beacon.source, beaconRound]);
    dataKey.fill(0);

    const prizeTableHash = sha256(JSON.stringify(tiers.rows));
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
  const unsold = await one<{ n: number }>(db, "SELECT count(*)::int AS n FROM tickets WHERE cycle_id = $1 AND status = 'UNSOLD'", [cycleId]);
  const soldOut = unsold!.n === 0;
  const timeUp = cycle.sales_close_at.getTime() <= Date.now();
  if (!soldOut && !timeUp) return false;
  await db.query("UPDATE cycles SET status = 'CLOSED' WHERE id = $1", [cycleId]);
  await audit(db, actor, "cycle.closed", "cycle", cycleId, { reason: soldOut ? "SOLD_OUT" : "CLOSING_TIME", unsold: unsold!.n });
  return true;
}

/** Run periodically: closes every open cycle that has sold out or reached its closing time. */
export async function closeDueCycles(ctx: Ctx): Promise<string[]> {
  const due = await ctx.pool.query<{ id: string }>(
    `SELECT c.id FROM cycles c WHERE c.status = 'OPEN'
       AND (c.sales_close_at <= now() OR NOT EXISTS (SELECT 1 FROM tickets t WHERE t.cycle_id = c.id AND t.status = 'UNSOLD'))`);
  const closed: string[] = [];
  for (const { id } of due.rows) {
    if (await withTx(ctx.pool, (db) => closeIfDue(db, id))) closed.push(id);
  }
  return closed;
}

// --- Public catalogue ------------------------------------------------------------------

export async function listPublicCycles(ctx: Ctx): Promise<unknown[]> {
  const r = await ctx.pool.query(
    `SELECT c.id, c.name, c.status, c.mode, c.state_code, c.ticket_price_kobo, c.total_tickets, c.max_tickets_per_account,
            c.sales_open_at, c.sales_close_at, c.draw_at, c.claim_window_days,
            (SELECT count(*) FROM tickets t WHERE t.cycle_id = c.id AND t.status = 'UNSOLD')::int AS tickets_remaining
     FROM cycles c WHERE c.status IN ('COMMITTED','OPEN','CLOSED','DRAWN','SETTLING','ARCHIVED') ORDER BY c.sales_open_at DESC`);
  return r.rows;
}

export async function getPublicCycle(ctx: Ctx, cycleId: string): Promise<unknown> {
  const c = await one<Record<string, unknown> & { total_tickets: number }>(
    ctx.pool,
    `SELECT c.id, c.name, c.status, c.mode, c.state_code, c.ticket_price_kobo, c.total_tickets, c.max_tickets_per_account,
            c.sales_open_at, c.sales_close_at, c.draw_at, c.claim_window_days, c.rules_document_ref, encode(c.rules_sha256, 'hex') AS rules_sha256,
            (SELECT count(*) FROM tickets t WHERE t.cycle_id = c.id AND t.status = 'UNSOLD')::int AS tickets_remaining
     FROM cycles c WHERE c.id = $1 AND c.status IN ('COMMITTED','OPEN','CLOSED','DRAWN','SETTLING','ARCHIVED')`, [cycleId]);
  if (!c) throw notFound("Cycle not found.");
  const tiers = await ctx.pool.query<{ stage: string; kind: string; title: string; cash_kobo: number | null; quantity: number; draw_order: number | null }>(
    "SELECT stage, kind, title, cash_kobo, quantity, draw_order FROM prize_tiers WHERE cycle_id = $1 ORDER BY stage DESC, draw_order NULLS LAST, cash_kobo DESC", [cycleId]);
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

export function assertSimulated(cycle: CycleRow): void {
  if (cycle.mode !== "SIMULATED") throw new AppError(403, "REAL_MONEY_DISABLED", "Real-money play is not enabled.");
}
