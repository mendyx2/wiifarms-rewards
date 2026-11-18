import { audit } from "../audit.ts";
import type { Ctx } from "../context.ts";
import { open } from "../crypto.ts";
import { one, withTx, type Db } from "../db.ts";
import { badRequest, conflict, forbidden, notFound } from "../errors.ts";
import { adminActor, requireRole, type Admin } from "./admin.ts";
import { cycleKeyContext, getCycle, ticketAad } from "./cycles.ts";

/**
 * Closing out a cycle after its draw.
 *
 * A cycle manager or Compliance requests the close-out (DRAWN -> SETTLING)
 * once every check passes; someone in Finance, a different person, confirms
 * it (SETTLING -> ARCHIVED). On confirmation the outcome and salt of every
 * card — sold, unsold or cancelled — is published, so anyone can rebuild the
 * fingerprint that was published before sales opened and see that every
 * advertised prize was really there.
 */

export interface Check { key: string; ok: boolean; label: string; detail: string }

const TZ = "Africa/Lagos";

/** Claims whose published claim window has ended are closed before checking. */
async function expireCycleClaims(db: Db, cycleId: string): Promise<number> {
  const r = await db.query(
    `UPDATE prize_claims SET status = 'EXPIRED' WHERE status = 'ENTITLED' AND expires_at < now()
     AND prize_tier_id IN (SELECT id FROM prize_tiers WHERE cycle_id = $1)`, [cycleId]);
  return r.rowCount ?? 0;
}

async function checks(db: Db, cycleId: string): Promise<Check[]> {
  const cycle = await getCycle(db, cycleId);
  const drawn = ["DRAWN", "SETTLING", "ARCHIVED"].includes(cycle.status);
  const claims = (await one<{ waiting: number; lapsed: number; held: number; delivering: number; next_expiry: Date | null }>(db,
    `SELECT count(*) FILTER (WHERE pc.status = 'ENTITLED' AND pc.expires_at >= now())::int AS waiting,
            count(*) FILTER (WHERE pc.status = 'ENTITLED' AND pc.expires_at < now())::int AS lapsed,
            count(*) FILTER (WHERE pc.status = 'ON_HOLD')::int AS held,
            count(*) FILTER (WHERE pc.status IN ('VERIFIED','DISPATCHED'))::int AS delivering,
            max(pc.expires_at) FILTER (WHERE pc.status = 'ENTITLED') AS next_expiry
     FROM prize_claims pc JOIN prize_tiers pt ON pt.id = pc.prize_tier_id WHERE pt.cycle_id = $1`, [cycleId]))!;
  const openClaims = claims.waiting + claims.held + claims.delivering;
  // Every day on which this cycle's money moved through the provider must be reconciled and signed off.
  const days = (await db.query<{ day: string; signed: boolean }>(
    `SELECT DISTINCT (e.created_at AT TIME ZONE '${TZ}')::date::text AS day, coalesce(r.signed_off_by IS NOT NULL, false) AS signed
     FROM ledger_entries e JOIN ledger_transactions t ON t.id = e.transaction_id JOIN ledger_accounts a ON a.id = e.account_id
     LEFT JOIN reconciliations r ON r.day = (e.created_at AT TIME ZONE '${TZ}')::date
     WHERE a.code = 'GATEWAY_CLEARING' AND t.cycle_id = $1 ORDER BY 1`, [cycleId])).rows;
  const unsigned = days.filter((d) => !d.signed).map((d) => d.day);
  const alerts = (await one<{ n: number }>(db,
    `SELECT count(*)::int AS n FROM compliance_alerts a WHERE a.status = 'OPEN' AND (
       (a.entity_type = 'cycle' AND a.entity_id = $1::text AND a.kind <> 'CYCLE_VOIDED') OR
       (a.entity_type = 'prize_claim' AND a.entity_id IN (SELECT pc.id::text FROM prize_claims pc JOIN prize_tiers pt ON pt.id = pc.prize_tier_id WHERE pt.cycle_id::text = $1)))`, [cycleId]))!.n;
  const parts = [claims.waiting && `${claims.waiting} waiting for the winner${claims.next_expiry ? ` (window ends ${claims.next_expiry.toISOString().slice(0, 10)})` : ""}`,
    claims.held && `${claims.held} on hold`, claims.delivering && `${claims.delivering} being delivered`].filter(Boolean);
  return [
    { key: "drawn", ok: drawn, label: "Final draw completed", detail: drawn ? "Winners published." : "The draw has not taken place." },
    { key: "claims", ok: openClaims === 0, label: "Every prize claimed, delivered or expired",
      detail: (openClaims === 0 ? "No prize claims are open." : parts.join(", ") + ".") +
        (claims.lapsed ? ` ${claims.lapsed} unclaimed past the window will be closed as expired.` : "") },
    { key: "reconciled", ok: unsigned.length === 0, label: "Money reconciled and signed off",
      detail: unsigned.length === 0 ? `${days.length} day${days.length === 1 ? "" : "s"} with money movement, all signed off.` : `Not signed off: ${unsigned.join(", ")}.` },
    { key: "alerts", ok: alerts === 0, label: "No open alerts about this cycle", detail: alerts === 0 ? "None." : `${alerts} open alert${alerts === 1 ? "" : "s"} for Compliance to resolve.` },
  ];
}

export async function archiveReadiness(ctx: Ctx, admin: Admin, cycleId: string): Promise<Check[]> {
  if (!admin.roles.length) throw notFound();
  const db = await ctx.pool.connect();
  try {
    await getCycle(db, cycleId);
    return await checks(db, cycleId); // read-only
  } finally {
    db.release();
  }
}

function assertReady(c: Check[]): void {
  const failing = c.filter((x) => !x.ok);
  if (failing.length) throw conflict("NOT_READY", "The cycle cannot be closed yet: " + failing.map((f) => `${f.label.toLowerCase()} — ${f.detail}`).join(" "));
}

export async function requestArchive(ctx: Ctx, admin: Admin, cycleId: string): Promise<{ status: string; expiredClaims: number }> {
  requireRole(admin, "CYCLE_MANAGER", "COMPLIANCE");
  return withTx(ctx.pool, async (db) => {
    const cycle = await getCycle(db, cycleId, true);
    if (cycle.status !== "DRAWN") throw conflict("NOT_DRAWN", cycle.status === "SETTLING" ? "Close-out has already been requested." : "Only a cycle whose draw is complete can be closed out.");
    const expiredClaims = await expireCycleClaims(db, cycleId);
    assertReady(await checks(db, cycleId));
    await db.query("UPDATE cycles SET status = 'SETTLING', archive_requested_by = $2, archive_requested_at = now() WHERE id = $1", [cycleId, admin.id]);
    await audit(db, adminActor(admin), "cycle.archive_requested", "cycle", cycleId, { expiredClaims });
    return { status: "SETTLING", expiredClaims };
  });
}

/**
 * Finance confirms. In one transaction: the checks are run again, every card's
 * outcome is decrypted and published, merchandise still reserved (from prizes
 * that expired unclaimed) returns to stock, and the cycle becomes ARCHIVED.
 */
export async function confirmArchive(ctx: Ctx, admin: Admin, cycleId: string): Promise<{ status: string; published: number; stockReleased: number }> {
  requireRole(admin, "FINANCE");
  return withTx(ctx.pool, async (db) => {
    const cycle = await one<{ status: string; archive_requested_by: string | null }>(db, "SELECT status, archive_requested_by FROM cycles WHERE id = $1 FOR NO KEY UPDATE", [cycleId]);
    if (!cycle) throw notFound("Cycle not found.");
    if (cycle.status !== "SETTLING") throw conflict("NOT_REQUESTED", cycle.status === "ARCHIVED" ? "This cycle is already archived." : "Close-out has not been requested for this cycle.");
    if (cycle.archive_requested_by === admin.id) throw forbidden("SAME_PERSON", "You requested this close-out, so someone else must confirm it.");
    await expireCycleClaims(db, cycleId);
    assertReady(await checks(db, cycleId));

    const secrets = await one<{ wrapped_data_key: Buffer }>(db, "SELECT wrapped_data_key FROM cycle_secrets WHERE cycle_id = $1", [cycleId]);
    const dataKey = await ctx.keys.unwrap(secrets!.wrapped_data_key, cycleKeyContext(cycleId));
    const tickets = await db.query<{ leaf_index: number; serial: string; status: string; outcome_ciphertext: Buffer }>(
      "SELECT leaf_index, serial, status, outcome_ciphertext FROM tickets WHERE cycle_id = $1 ORDER BY leaf_index", [cycleId]);
    const rows = { idx: [] as number[], serial: [] as string[], outcome: [] as string[], salt: [] as Buffer[], status: [] as string[] };
    for (const t of tickets.rows) {
      const plain = JSON.parse(open(dataKey, t.outcome_ciphertext, ticketAad(cycleId, t.serial)).toString()) as { o: string; s: string };
      rows.idx.push(t.leaf_index); rows.serial.push(t.serial); rows.outcome.push(plain.o); rows.salt.push(Buffer.from(plain.s, "hex")); rows.status.push(t.status);
    }
    dataKey.fill(0);
    await db.query(
      `INSERT INTO published_tickets (cycle_id, leaf_index, serial, outcome, salt, sale_status)
       SELECT $1, * FROM unnest($2::int[], $3::text[], $4::text[], $5::bytea[], $6::text[])`,
      [cycleId, rows.idx, rows.serial, rows.outcome, rows.salt, rows.status]);
    await db.query("UPDATE cycles SET status = 'ARCHIVED', archived_by = $2, archived_at = now() WHERE id = $1", [cycleId, admin.id]);
    const released = await db.query("UPDATE stock_units SET status = 'IN_STOCK', reserved_cycle_id = NULL WHERE reserved_cycle_id = $1 AND status = 'RESERVED'", [cycleId]);
    await audit(db, adminActor(admin), "cycle.archived", "cycle", cycleId, { published: tickets.rows.length, stockReleased: released.rowCount });
    return { status: "ARCHIVED", published: tickets.rows.length, stockReleased: released.rowCount ?? 0 };
  });
}

/** The published card list of an archived cycle, in fingerprint order. Public. */
export async function publishedTickets(ctx: Ctx, cycleId: string, offset = 0, limit = 5000): Promise<unknown> {
  const c = await one<{ status: string; total_tickets: number }>(ctx.pool, "SELECT status, total_tickets FROM cycles WHERE id = $1", [cycleId]);
  if (!c || c.status !== "ARCHIVED") throw notFound("The full card list is published when the cycle is archived.");
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 5000) throw badRequest("INVALID_RANGE", "Invalid page.");
  const r = await ctx.pool.query(
    `SELECT leaf_index, serial, outcome, encode(salt, 'hex') AS salt, sale_status FROM published_tickets
     WHERE cycle_id = $1 AND leaf_index >= $2 ORDER BY leaf_index LIMIT $3`, [cycleId, offset, limit]);
  return { cycleId, total: c.total_tickets, offset, tickets: r.rows };
}
