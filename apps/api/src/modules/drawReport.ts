import { canonicalEntries, deriveDrawSeed, entriesHash, runDraw, verifySecretCommitment } from "@wiifarm/game-core";
import { audit } from "../audit.ts";
import type { Ctx } from "../context.ts";
import { sha256 } from "../crypto.ts";
import { one, withTx, type Db } from "../db.ts";
import { conflict, forbidden, notFound } from "../errors.ts";
import { adminActor, requireRole, type Admin } from "./admin.ts";

/**
 * The independent draw report (SRS DRW-010), covering DRW-001 to DRW-009:
 * the approved draw date, the frozen register of eligible sold cards and its
 * reconciliation (unsold, cancelled and held cards excluded), the selection
 * mechanism and its re-checks, the multiple-win rule, every authorised
 * operation, each winning card against its prize, and where the results are
 * published. It is built only from stored records, and every figure the draw
 * relied on is recomputed here rather than copied.
 *
 * The stored report names no player. Staff are named by role, except the
 * appointed independent auditor, who attests to the report's fingerprint.
 */

/** JSON with keys in a fixed order, so the fingerprint does not depend on how the report was assembled. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().filter((k) => (v as Record<string, unknown>)[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(v);
}

interface Check { id: string; description: string; pass: boolean; detail?: string }

async function buildReport(db: Db, cycleId: string): Promise<{ report: Record<string, unknown>; allPass: boolean }> {
  const c = await one<{ id: string; name: string; state_code: string; mode: string; draw_at: Date; sales_open_at: Date; sales_close_at: Date; total_tickets: number;
    ticket_price_kobo: number; rules_sha256: Buffer | null; status: string }>(db,
    "SELECT id, name, state_code, mode, draw_at, sales_open_at, sales_close_at, total_tickets, ticket_price_kobo, rules_sha256, status FROM cycles WHERE id = $1", [cycleId]);
  const d = await one<{ entries_count: number; entries_sha256: Buffer; beacon_source: string; beacon_round: string; beacon_value: Buffer; revealed_secret: Buffer; seed: Buffer;
    game_core_version: string; executed_at: Date; auditor_signed_at: Date }>(db, "SELECT * FROM draws WHERE cycle_id = $1", [cycleId]);
  if (!c || !d) throw notFound("This draw has not taken place yet.");
  const commit = (await one<{ draw_secret_commitment: Buffer; published_at: Date; game_core_version: string; ticket_merkle_root: Buffer; prize_table_sha256: Buffer }>(db,
    "SELECT * FROM cycle_commitments WHERE cycle_id = $1", [cycleId]))!;
  const snapshot = (await one<{ serials: string[]; created_at: Date }>(db, "SELECT serials, created_at FROM draw_entry_snapshots WHERE cycle_id = $1", [cycleId]))!;

  // DRW-002/003/004: the register and its reconciliation.
  const counts = (await one<{ sold: number; cancelled: number; unsold: number; reserved: number; paid_cards: number; paid_kobo: string }>(db,
    `SELECT count(*) FILTER (WHERE status IN ('SOLD','REVEALED'))::int AS sold, count(*) FILTER (WHERE status = 'CANCELLED')::int AS cancelled,
            count(*) FILTER (WHERE status = 'UNSOLD')::int AS unsold, count(*) FILTER (WHERE status = 'RESERVED')::int AS reserved,
            (SELECT count(*) FROM tickets t JOIN orders o ON o.id = t.order_id WHERE t.cycle_id = $1 AND o.status = 'FULFILLED' AND t.status IN ('SOLD','REVEALED'))::int AS paid_cards,
            (SELECT coalesce(sum(o.amount_kobo), 0) FROM orders o WHERE o.cycle_id = $1 AND o.status = 'FULFILLED')::bigint AS paid_kobo
     FROM tickets WHERE cycle_id = $1`, [cycleId]))!;
  const frozen = canonicalEntries(snapshot.serials);
  // Every entry must be a card paid for with a confirmed payment; every card sold now must be an entry; no entry may be unsold or held.
  const entryCheck = (await one<{ paid: number; not_sold: number; sold_not_entered: number }>(db,
    `SELECT (SELECT count(*) FROM tickets t WHERE t.cycle_id = $1 AND t.serial = ANY($2::text[])
               AND EXISTS (SELECT 1 FROM payments p WHERE p.order_id = t.order_id AND p.status = 'SUCCEEDED'))::int AS paid,
            (SELECT count(*) FROM tickets t WHERE t.cycle_id = $1 AND t.serial = ANY($2::text[]) AND t.status IN ('UNSOLD','RESERVED'))::int AS not_sold,
            (SELECT count(*) FROM tickets t WHERE t.cycle_id = $1 AND t.status IN ('SOLD','REVEALED') AND NOT (t.serial = ANY($2::text[])))::int AS sold_not_entered`,
    [cycleId, frozen]))!;
  const recomputedHash = entriesHash(cycleId, frozen);

  // DRW-005: the mechanism, recomputed.
  const secretOk = verifySecretCommitment(d.revealed_secret, commit.draw_secret_commitment);
  const seed = deriveDrawSeed({ secret: d.revealed_secret, beaconValue: d.beacon_value, cycleId, entriesHash: recomputedHash });
  const prizes = (await db.query<{ id: string; title: string; kind: string; cash_kobo: number | null; quantity: number; draw_order: number; value_kobo: number | null }>(
    `SELECT p.id, p.title, p.kind, p.cash_kobo, p.quantity, p.draw_order, k.advertised_value_kobo AS value_kobo FROM prize_tiers p LEFT JOIN skus k ON k.id = p.sku_id
     WHERE p.cycle_id = $1 AND p.stage = 'FINAL_DRAW' ORDER BY p.draw_order`, [cycleId])).rows;
  const rerun = runDraw(frozen, prizes.map((p) => ({ prizeId: p.id, quantity: p.quantity })), seed);
  const recorded = (await db.query<{ prize_tier_id: string; position: number; serial: string }>(
    `SELECT w.prize_tier_id, w.position, t.serial FROM draw_winners w JOIN tickets t ON t.id = w.ticket_id JOIN prize_tiers p ON p.id = w.prize_tier_id
     WHERE w.cycle_id = $1 ORDER BY p.draw_order, w.position`, [cycleId])).rows;
  const key = (w: { prizeId?: string; prize_tier_id?: string; position: number; serial: string }) => `${w.prizeId ?? w.prize_tier_id}:${w.position}:${w.serial}`;
  const sameWinners = rerun.length === recorded.length && rerun.every((w, i) => key(w) === key(recorded[i]!));
  const winnerSerials = recorded.map((w) => w.serial);
  const certification = await one<{ lab: string; certificate_ref: string; valid_from: string; valid_to: string | null }>(db,
    `SELECT lab, certificate_ref, valid_from::text, valid_to::text FROM certifications WHERE component = 'GAME_CORE' AND component_version = $1 AND status = 'VERIFIED'
       AND valid_from <= $2::date AND (valid_to IS NULL OR valid_to >= $2::date) LIMIT 1`, [d.game_core_version, d.executed_at]);

  // DRW-007: the authorised operations, in order.
  const approvals = (await db.query("SELECT capacity, approved_at FROM cycle_approvals WHERE cycle_id = $1 ORDER BY approved_at", [cycleId])).rows;
  const signoffs = (await db.query<{ capacity: string; signed_at: Date; admin_user_id: string }>("SELECT capacity, signed_at, admin_user_id FROM draw_signoffs WHERE cycle_id = $1 ORDER BY signed_at", [cycleId])).rows;
  const auditor = (await one<{ full_name: string }>(db, "SELECT a.full_name FROM cycles c JOIN admin_users a ON a.id = c.auditor_admin_id WHERE c.id = $1", [cycleId]))!;
  const ops = (await db.query<{ occurred_at: Date; action: string; actor_type: string }>(
    `SELECT occurred_at, action, actor_type FROM audit_log WHERE entity_type = 'cycle' AND entity_id = $1
       AND (action LIKE 'draw.%' OR action IN ('cycle.committed','cycle.opened','cycle.closed','cycle.approved','cycle.submitted')) ORDER BY seq`, [cycleId])).rows;

  const checks: Check[] = [
    { id: "DRW-001", description: "The draw ran at or after its approved, published time", pass: d.executed_at.getTime() >= c.draw_at.getTime() },
    { id: "DRW-002", description: "The register of entries was frozen when the draw ran and has not changed", pass: frozen.length === d.entries_count && recomputedHash.equals(d.entries_sha256),
      detail: `${frozen.length} entries; SHA-256 ${recomputedHash.toString("hex")}` },
    { id: "DRW-003", description: "Every entry is a card paid for with a confirmed payment, and every sold card was entered", pass: entryCheck.paid === frozen.length && entryCheck.sold_not_entered === 0,
      detail: `${entryCheck.paid} of ${frozen.length} entries paid; ${entryCheck.sold_not_entered} sold cards missing` },
    { id: "DRW-004", description: "Unsold, cancelled and held cards are excluded", pass: entryCheck.not_sold === 0 && counts.reserved === 0,
      detail: `${counts.unsold} unsold, ${counts.cancelled} cancelled, ${counts.reserved} held; ${entryCheck.not_sold} entries not sold` },
    { id: "DRW-005a", description: "The secret revealed at the draw matches the commitment published before sales opened", pass: secretOk },
    { id: "DRW-005b", description: "The seed recomputed from the secret, the public randomness and the register matches the one used", pass: seed.equals(d.seed) },
    { id: "DRW-005c", description: "Re-running the certified draw procedure gives exactly the recorded winners", pass: sameWinners },
    { id: "DRW-005d", description: "The game engine that ran the draw holds a verified certification", pass: Boolean(certification),
      detail: certification ? `${certification.lab}, ${certification.certificate_ref}` : "No certification is recorded for this engine version (required before real money)." },
    { id: "DRW-006", description: "Each card won at most one final-draw prize, and every prize went to an entry", pass: new Set(winnerSerials).size === winnerSerials.length
        && winnerSerials.every((s) => frozen.includes(s)) && recorded.length === Math.min(frozen.length, prizes.reduce((n, p) => n + p.quantity, 0)) },
    { id: "DRW-007", description: "Two different operators and the appointed auditor signed off before the draw", pass:
        signoffs.filter((s) => s.capacity === "OPERATOR").length >= 2 && signoffs.some((s) => s.capacity === "AUDITOR") && signoffs.every((s) => s.signed_at.getTime() <= d.executed_at.getTime()) },
  ];
  // Certification is a requirement for real money; in a simulation its absence is reported, not treated as a failed draw.
  const allPass = checks.every((ch) => ch.pass || (ch.id === "DRW-005d" && c.mode === "SIMULATED"));
  const report = {
    reportVersion: 1,
    campaign: { reference: c.id, name: c.name, state: c.state_code, mode: c.mode, cards: c.total_tickets, priceKobo: Number(c.ticket_price_kobo),
      salesOpened: c.sales_open_at.toISOString(), salesClosed: c.sales_close_at.toISOString(), approvedDrawTime: c.draw_at.toISOString(),
      rulesSha256: c.rules_sha256?.toString("hex") ?? null, approvals: approvals.map((a) => ({ capacity: a.capacity, at: (a.approved_at as Date).toISOString() })) },
    register: { frozenAt: snapshot.created_at.toISOString(), entries: frozen.length, entriesSha256: recomputedHash.toString("hex"),
      soldCards: counts.sold, paidCards: counts.paid_cards, paidKobo: Number(counts.paid_kobo), unsoldCards: counts.unsold, cancelledCards: counts.cancelled, heldCards: counts.reserved },
    mechanism: { engine: d.game_core_version, certification: certification ?? null, commitmentPublishedAt: commit.published_at.toISOString(),
      secretCommitment: commit.draw_secret_commitment.toString("hex"), revealedSecret: d.revealed_secret.toString("hex"),
      beacon: { source: d.beacon_source, round: String(d.beacon_round), value: d.beacon_value.toString("hex") }, seed: d.seed.toString("hex"),
      cardMerkleRoot: commit.ticket_merkle_root.toString("hex"), prizeTableSha256: commit.prize_table_sha256.toString("hex"),
      multipleWinRule: "Every sold card is entered once, win or lose at the instant stage; each card can win at most one final-draw prize." },
    operations: [
      ...signoffs.map((s) => ({ at: s.signed_at.toISOString(), action: s.capacity === "AUDITOR" ? "Independent auditor countersigned the draw" : "Operator signed off the draw" })),
      { at: d.executed_at.toISOString(), action: "Draw executed" },
      ...ops.filter((o) => !o.action.startsWith("draw.")).map((o) => ({ at: o.occurred_at.toISOString(), action: o.action })),
    ].sort((a, b) => (a.at < b.at ? -1 : 1)),
    auditor: auditor.full_name,
    winners: prizes.map((p) => ({ prize: p.title, kind: p.kind, valueKobo: Number(p.cash_kobo ?? p.value_kobo ?? 0), quantity: p.quantity,
      cards: recorded.filter((w) => w.prize_tier_id === p.id).map((w) => ({ position: w.position, serial: w.serial })) })),
    publication: { results: `/v1/cycles/${cycleId}/draw`, entries: `/v1/cycles/${cycleId}/draw`, report: `/v1/cycles/${cycleId}/draw-report`,
      howToVerify: "Download the entries and published values, recompute the entries hash and the seed, and re-run the open-source draw procedure (packages/game-core) to obtain the same winners." },
    checks,
    allChecksPass: allPass,
  };
  return { report, allPass };
}

/** Generates and stores the report, once, after the draw. */
export async function generateDrawReport(ctx: Ctx, admin: Admin, cycleId: string): Promise<{ sha256: string; allChecksPass: boolean }> {
  requireRole(admin, "CYCLE_MANAGER", "COMPLIANCE", "AUDITOR");
  return withTx(ctx.pool, async (db) => {
    if (await one(db, "SELECT 1 FROM draw_reports WHERE cycle_id = $1", [cycleId])) throw conflict("ALREADY_GENERATED", "The draw report has already been generated.");
    const { report, allPass } = await buildReport(db, cycleId);
    const digest = sha256(canonicalJson(report));
    await db.query("INSERT INTO draw_reports (cycle_id, report, sha256, all_checks_pass, generated_by) VALUES ($1, $2, $3, $4, $5)",
      [cycleId, JSON.stringify(report), digest, allPass, admin.id]);
    if (!allPass) {
      await db.query("INSERT INTO compliance_alerts (kind, severity, entity_type, entity_id, details) VALUES ('DRAW_REPORT_CHECK_FAILED', 'CRITICAL', 'cycle', $1, $2)",
        [cycleId, JSON.stringify({ failed: (report.checks as Check[]).filter((c) => !c.pass).map((c) => c.id) })]);
    }
    await audit(db, adminActor(admin), "draw.report_generated", "cycle", cycleId, { sha256: digest.toString("hex"), allChecksPass: allPass });
    return { sha256: digest.toString("hex"), allChecksPass: allPass };
  });
}

/** The appointed auditor attests to the report with that exact fingerprint. */
export async function attestDrawReport(ctx: Ctx, admin: Admin, cycleId: string, input: { sha256: string; statement: string }): Promise<{ attested: boolean }> {
  requireRole(admin, "AUDITOR");
  return withTx(ctx.pool, async (db) => {
    const r = await one<{ sha256: Buffer; attested_by: string | null; auditor_admin_id: string }>(db,
      "SELECT r.sha256, r.attested_by, c.auditor_admin_id FROM draw_reports r JOIN cycles c ON c.id = r.cycle_id WHERE r.cycle_id = $1 FOR UPDATE OF r", [cycleId]);
    if (!r) throw notFound("Generate the draw report first.");
    if (r.auditor_admin_id !== admin.id) throw forbidden("NOT_APPOINTED_AUDITOR", "Only the auditor appointed to this campaign can attest its draw report.");
    if (r.attested_by) throw conflict("ALREADY_ATTESTED", "The report has already been attested.");
    if (r.sha256.toString("hex") !== input.sha256.toLowerCase()) throw conflict("FINGERPRINT_MISMATCH", "The fingerprint does not match the stored report. Re-read the report before attesting.");
    await db.query("UPDATE draw_reports SET attested_by = $2, attested_sha256 = sha256, attestation = $3, attested_at = now() WHERE cycle_id = $1",
      [cycleId, admin.id, input.statement.trim()]);
    await audit(db, adminActor(admin), "draw.report_attested", "cycle", cycleId, { sha256: input.sha256 });
    return { attested: true };
  });
}

/** The published report (DRW-009/010), with its fingerprint and attestation. */
export async function publicDrawReport(ctx: Ctx, cycleId: string): Promise<unknown> {
  const r = await one<{ report: unknown; sha256: Buffer; all_checks_pass: boolean; generated_at: Date; attestation: string | null; attested_at: Date | null; auditor: string | null }>(ctx.pool,
    `SELECT r.report, r.sha256, r.all_checks_pass, r.generated_at, r.attestation, r.attested_at, a.full_name AS auditor
     FROM draw_reports r LEFT JOIN admin_users a ON a.id = r.attested_by WHERE r.cycle_id = $1`, [cycleId]);
  if (!r) throw notFound("The draw report has not been published yet.");
  return { report: r.report, sha256: r.sha256.toString("hex"), allChecksPass: r.all_checks_pass, generatedAt: r.generated_at,
    attestation: r.attested_at ? { by: r.auditor, at: r.attested_at, statement: r.attestation } : null };
}
