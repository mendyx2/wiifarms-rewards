import { canonicalEntries, deriveDrawSeed, entriesHash, runDraw, verifySecretCommitment } from "@wiifarm/game-core";
import { audit } from "../audit.ts";
import type { Ctx } from "../context.ts";
import { open } from "../crypto.ts";
import { one, withTx } from "../db.ts";
import { conflict, forbidden, notFound } from "../errors.ts";
import { accounts, post } from "../ledger.ts";
import { adminActor, requireRole, type Admin } from "./admin.ts";
import { GAME_CORE_VERSION, cycleKeyContext, getCycle } from "./cycles.ts";
import { autoRevealCycle } from "./tickets.ts";

/**
 * Records one person's sign-off for a cycle's draw. Operators sign as
 * OPERATOR; the auditor appointed for this cycle signs as AUDITOR. Nobody can
 * sign twice, and sign-offs cannot be withdrawn or edited.
 */
export async function signDraw(ctx: Ctx, admin: Admin, cycleId: string): Promise<{ capacity: string }> {
  const cycle = await getCycle(ctx.pool, cycleId);
  if (cycle.status !== "CLOSED") throw conflict("NOT_CLOSED", "The draw can only be signed off once the cycle has closed.");
  let capacity: "OPERATOR" | "AUDITOR";
  if (admin.roles.includes("AUDITOR")) {
    if (admin.id !== cycle.auditor_admin_id) throw forbidden("NOT_APPOINTED", "Only the auditor appointed for this cycle can countersign its draw.");
    capacity = "AUDITOR";
  } else {
    requireRole(admin, "CYCLE_MANAGER", "FINANCE", "COMPLIANCE");
    capacity = "OPERATOR";
  }
  await withTx(ctx.pool, async (db) => {
    const r = await db.query(
      "INSERT INTO draw_signoffs (cycle_id, admin_user_id, capacity) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING", [cycleId, admin.id, capacity]);
    if (r.rowCount) await audit(db, adminActor(admin), "draw.signed_off", "cycle", cycleId, { capacity });
  });
  return { capacity };
}

/**
 * Runs the final draw. Requirements, all checked here and again by the
 * database: the cycle is closed; two different operators and the appointed
 * auditor have signed; the pre-announced beacon round has happened. The draw
 * runs over the cards actually sold — unsold inventory never takes part — and
 * it can run only once.
 */
export async function executeDraw(ctx: Ctx, admin: Admin, cycleId: string): Promise<{ winners: number; entries: number }> {
  requireRole(admin, "CYCLE_MANAGER", "FINANCE", "COMPLIANCE");
  const pre = await getCycle(ctx.pool, cycleId);
  if (pre.status !== "CLOSED") throw conflict("NOT_CLOSED", "The draw can only run on a closed cycle.");
  if (pre.draw_at.getTime() > Date.now()) throw conflict("TOO_EARLY", "The draw cannot run before its published time.");

  // Every sold card is revealed first, so instant prizes are settled before the draw.
  await autoRevealCycle(ctx, cycleId);

  const secrets = await one<{ wrapped_data_key: Buffer; draw_secret_ciphertext: Buffer; beacon_source: string; beacon_round: number }>(
    ctx.pool, "SELECT * FROM cycle_secrets WHERE cycle_id = $1", [cycleId]);
  if (!secrets) throw notFound("Cycle has no commitments.");
  const beaconValue = await ctx.beacon.get(secrets.beacon_round);
  if (!beaconValue) throw conflict("BEACON_NOT_READY", "The announced randomness round has not happened yet. Try again shortly.");

  return withTx(ctx.pool, async (db) => {
    const cycle = await getCycle(db, cycleId, true);
    if (cycle.status !== "CLOSED") throw conflict("NOT_CLOSED", "The draw can only run on a closed cycle.");

    const signoffs = await db.query<{ admin_user_id: string; capacity: string; signed_at: Date }>(
      "SELECT admin_user_id, capacity, signed_at FROM draw_signoffs WHERE cycle_id = $1 ORDER BY signed_at", [cycleId]);
    const operators = signoffs.rows.filter((s) => s.capacity === "OPERATOR");
    const auditor = signoffs.rows.find((s) => s.capacity === "AUDITOR" && s.admin_user_id === cycle.auditor_admin_id);
    if (operators.length < 2) throw conflict("SIGNOFF_MISSING", "Two different operators must sign off before the draw.");
    if (!auditor) throw conflict("SIGNOFF_MISSING", "The appointed auditor must countersign before the draw.");

    // Eligible entries: every card that was paid for and not cancelled or refunded.
    const entries = await db.query<{ id: string; serial: string; owner_id: string }>(
      "SELECT id, serial, owner_id FROM tickets WHERE cycle_id = $1 AND status IN ('SOLD','REVEALED')", [cycleId]);
    const serials = canonicalEntries(entries.rows.map((e) => e.serial));
    const bySerial = new Map(entries.rows.map((e) => [e.serial, e]));
    const eh = entriesHash(cycleId, serials);
    await db.query("INSERT INTO draw_entry_snapshots (cycle_id, serials) VALUES ($1, $2)", [cycleId, serials]);

    // Open the secret committed before sales and prove it is the same one.
    const dataKey = await ctx.keys.unwrap(secrets.wrapped_data_key, cycleKeyContext(cycleId));
    const secret = open(dataKey, secrets.draw_secret_ciphertext, `draw-secret:${cycleId}`);
    dataKey.fill(0);
    const commitment = await one<{ draw_secret_commitment: Buffer }>(db, "SELECT draw_secret_commitment FROM cycle_commitments WHERE cycle_id = $1", [cycleId]);
    if (!verifySecretCommitment(secret, commitment!.draw_secret_commitment)) {
      throw new Error("draw secret does not match its published commitment");
    }

    const seed = deriveDrawSeed({ secret, beaconValue, cycleId, entriesHash: eh });
    const tiers = await db.query<{ id: string; kind: string; cash_kobo: number | null; quantity: number }>(
      "SELECT id, kind, cash_kobo, quantity FROM prize_tiers WHERE cycle_id = $1 AND stage = 'FINAL_DRAW' ORDER BY draw_order", [cycleId]);
    const winners = runDraw(serials, tiers.rows.map((t) => ({ prizeId: t.id, quantity: t.quantity })), seed);

    await db.query(
      `INSERT INTO draws (cycle_id, entries_count, entries_sha256, entries_snapshot_ref, beacon_source, beacon_round, beacon_value,
                          revealed_secret, seed, game_core_version, operator_1, operator_2, auditor_id, auditor_signed_at)
       VALUES ($1, $2, $3, 'db:draw_entry_snapshots', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [cycleId, serials.length, eh, secrets.beacon_source, secrets.beacon_round, beaconValue, secret, seed, GAME_CORE_VERSION,
        operators[0]!.admin_user_id, operators[1]!.admin_user_id, auditor.admin_user_id, auditor.signed_at]);

    for (const w of winners) {
      const ticket = bySerial.get(w.serial)!;
      const tier = tiers.rows.find((t) => t.id === w.prizeId)!;
      await db.query("INSERT INTO draw_winners (cycle_id, prize_tier_id, position, ticket_id) VALUES ($1, $2, $3, $4)", [cycleId, w.prizeId, w.position, ticket.id]);
      if (tier.kind === "CASH") {
        // Cash goes to the winner's winnings balance; taking it out still passes the payout controls.
        await post(db, { kind: "DRAW_PRIZE", reference: `ticket:${ticket.id}:draw`, cycleId, debit: accounts.prizeExpense(cycleId), credit: accounts.playerWinnings(ticket.owner_id), amountKobo: tier.cash_kobo! });
      }
      await db.query(
        `INSERT INTO prize_claims (ticket_id, stage, prize_tier_id, user_id, status, expires_at)
         VALUES ($1, 'FINAL_DRAW', $2, $3, $4, now() + make_interval(days => $5))`,
        [ticket.id, w.prizeId, ticket.owner_id, tier.kind === "CASH" ? "PAID" : "ENTITLED", cycle.claim_window_days]);
    }

    await db.query("UPDATE cycles SET status = 'DRAWN' WHERE id = $1", [cycleId]);
    await audit(db, adminActor(admin), "draw.executed", "cycle", cycleId,
      { entries: serials.length, winners: winners.length, entriesHash: eh.toString("hex"), beaconRound: secrets.beacon_round });
    return { winners: winners.length, entries: serials.length };
  });
}

/** Everything a member of the public needs to re-run the draw and check the winners. */
export async function getPublicDraw(ctx: Ctx, cycleId: string): Promise<unknown> {
  const d = await one<Record<string, unknown>>(
    ctx.pool,
    `SELECT d.cycle_id, d.entries_count, encode(d.entries_sha256, 'hex') AS entries_sha256, d.beacon_source, d.beacon_round,
            encode(d.beacon_value, 'hex') AS beacon_value, encode(d.revealed_secret, 'hex') AS secret, encode(d.seed, 'hex') AS seed,
            encode(cc.draw_secret_commitment, 'hex') AS secret_commitment, d.game_core_version, d.executed_at, d.auditor_signed_at
     FROM draws d JOIN cycle_commitments cc ON cc.cycle_id = d.cycle_id WHERE d.cycle_id = $1`, [cycleId]);
  if (!d) throw notFound("This draw has not taken place yet.");
  const snapshot = await one<{ serials: string[] }>(ctx.pool, "SELECT serials FROM draw_entry_snapshots WHERE cycle_id = $1", [cycleId]);
  const prizes = await ctx.pool.query("SELECT id AS prize_id, title, quantity, draw_order FROM prize_tiers WHERE cycle_id = $1 AND stage = 'FINAL_DRAW' ORDER BY draw_order", [cycleId]);
  const winners = await ctx.pool.query(
    `SELECT w.prize_tier_id AS prize_id, p.title, w.position, t.serial
     FROM draw_winners w JOIN prize_tiers p ON p.id = w.prize_tier_id JOIN tickets t ON t.id = w.ticket_id
     WHERE w.cycle_id = $1 ORDER BY p.draw_order, w.position`, [cycleId]);
  return { ...d, entries: snapshot?.serials ?? [], prizes: prizes.rows, winners: winners.rows };
}
