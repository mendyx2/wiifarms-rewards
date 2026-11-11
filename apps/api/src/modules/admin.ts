import { audit, type Actor } from "../audit.ts";
import type { Ctx } from "../context.ts";
import { keyedHash, newToken, sha256 } from "../crypto.ts";
import { one, withTx } from "../db.ts";
import { badRequest, forbidden, notFound, unauthorized } from "../errors.ts";
import { normalisePhone } from "./identity.ts";

export type Role = "CYCLE_MANAGER" | "FINANCE" | "PAYOUT_APPROVER" | "FULFILMENT" | "SUPPORT" | "COMPLIANCE" | "AUDITOR" | "SECURITY_ADMIN";

export interface Admin {
  id: string;
  email: string;
  fullName: string;
  roles: Role[];
}

export const adminActor = (a: Admin, ip?: string): Actor => ({ type: "ADMIN", id: a.id, ip });

export async function authenticateAdmin(ctx: Ctx, token: string | undefined): Promise<Admin> {
  if (!token) throw unauthorized();
  const row = await one<{ id: string; email: string; full_name: string; roles: Role[] }>(
    ctx.pool,
    `SELECT a.id, a.email, a.full_name,
            coalesce(array_agg(r.role) FILTER (WHERE r.role IS NOT NULL), '{}')::text[] AS roles
     FROM admin_sessions s JOIN admin_users a ON a.id = s.admin_user_id
     LEFT JOIN admin_roles r ON r.admin_user_id = a.id
     WHERE s.token_hash = $1 AND s.expires_at > now() AND a.status = 'ACTIVE'
     GROUP BY a.id`,
    [sha256(token)]);
  if (!row) throw unauthorized();
  return { id: row.id, email: row.email, fullName: row.full_name, roles: row.roles };
}

export function requireRole(admin: Admin, ...roles: Role[]): void {
  if (!roles.some((r) => admin.roles.includes(r))) {
    throw forbidden("ROLE_REQUIRED", `This action needs one of these roles: ${roles.join(", ")}.`);
  }
}

/**
 * Simulation-only sign-in by email. Production admins sign in through the
 * company's single sign-on with a hardware key; this function refuses to run
 * outside simulation.
 */
export async function devAdminLogin(ctx: Ctx, email: string): Promise<{ token: string }> {
  if (!ctx.config.simulated) throw forbidden("NOT_AVAILABLE", "Not available.");
  const admin = await one<{ id: string }>(ctx.pool, "SELECT id FROM admin_users WHERE email = $1 AND status = 'ACTIVE'", [email]);
  if (!admin) throw unauthorized("Unknown administrator.");
  const { token, hash } = newToken();
  await ctx.pool.query("INSERT INTO admin_sessions (token_hash, admin_user_id, expires_at) VALUES ($1, $2, now() + interval '8 hours')", [hash, admin.id]);
  return { token };
}

/** Adds a person to the staff/family/auditor/supplier exclusion register. */
export async function addToExclusionRegister(ctx: Ctx, admin: Admin, input: { category: string; phone?: string; idKind?: "NIN" | "BVN"; idNumber?: string; note?: string }): Promise<{ id: string }> {
  requireRole(admin, "COMPLIANCE");
  const phone = input.phone ? normalisePhone(input.phone) : null;
  const identityHash = input.idKind && input.idNumber ? keyedHash(ctx.config.hashKey, "identity", `${input.idKind}:${input.idNumber}`) : null;
  if (!phone && !identityHash) throw badRequest("INVALID_ENTRY", "Give a phone number or an identity number.");
  return withTx(ctx.pool, async (db) => {
    const r = await db.query<{ id: string }>(
      "INSERT INTO exclusion_register (category, identity_hash, phone_e164, note, added_by) VALUES ($1, $2, $3, $4, $5) RETURNING id",
      [input.category, identityHash, phone, input.note ?? null, admin.id]);
    await audit(db, adminActor(admin), "compliance.exclusion_added", "exclusion_register", r.rows[0]!.id, { category: input.category });
    return { id: r.rows[0]!.id };
  });
}

/** Figures for the management dashboard, all derived from tickets and the ledger. */
export async function dashboard(ctx: Ctx, admin: Admin): Promise<unknown> {
  requireRole(admin, "CYCLE_MANAGER", "FINANCE", "PAYOUT_APPROVER", "COMPLIANCE", "AUDITOR", "FULFILMENT");
  const cycles = await ctx.pool.query(
    `SELECT c.id, c.name, c.status, c.mode, c.ticket_price_kobo, c.total_tickets, c.sales_close_at, c.draw_at,
            c.escrow_funded_kobo,
            (SELECT count(*) FROM tickets t WHERE t.cycle_id = c.id AND t.status IN ('SOLD','REVEALED'))::int AS sold,
            (SELECT count(*) FROM tickets t WHERE t.cycle_id = c.id AND t.status = 'REVEALED')::int AS revealed,
            -coalesce((SELECT balance_kobo FROM ledger_balances WHERE code = 'TICKET_REVENUE:' || c.id), 0) AS revenue_kobo,
            coalesce((SELECT balance_kobo FROM ledger_balances WHERE code = 'PRIZE_EXPENSE:' || c.id), 0) AS prizes_awarded_kobo,
            coalesce((SELECT sum(cash_kobo * quantity) FROM prize_tiers p WHERE p.cycle_id = c.id AND p.stage = 'INSTANT'), 0)::bigint AS instant_total_kobo,
            coalesce((SELECT sum(cash_kobo * quantity) FROM prize_tiers p WHERE p.cycle_id = c.id AND p.stage = 'FINAL_DRAW' AND p.kind = 'CASH'), 0)::bigint AS draw_cash_total_kobo,
            coalesce((SELECT sum(pt.cash_kobo) FROM prize_claims pc JOIN prize_tiers pt ON pt.id = pc.prize_tier_id
                      WHERE pt.cycle_id = c.id AND pc.stage = 'INSTANT'), 0)::bigint AS instant_revealed_kobo,
            (SELECT count(*) FROM prize_claims pc JOIN prize_tiers pt ON pt.id = pc.prize_tier_id
              WHERE pt.cycle_id = c.id AND pt.kind = 'MERCHANDISE' AND pc.status NOT IN ('DELIVERED','EXPIRED','VOID'))::int AS merchandise_outstanding
     FROM cycles c ORDER BY c.created_at DESC`);
  const totals = await one<{ winnings_payable_kobo: number; payouts_in_transit_kobo: number; gateway_clearing_kobo: number; ledger_sum: number }>(
    ctx.pool,
    `SELECT -coalesce(sum(balance_kobo) FILTER (WHERE code LIKE 'PLAYER_WINNINGS:%'), 0)::bigint AS winnings_payable_kobo,
            -coalesce(sum(balance_kobo) FILTER (WHERE code = 'PAYOUTS_IN_TRANSIT'), 0)::bigint AS payouts_in_transit_kobo,
            coalesce(sum(balance_kobo) FILTER (WHERE code = 'GATEWAY_CLEARING'), 0)::bigint AS gateway_clearing_kobo,
            coalesce(sum(balance_kobo), 0)::bigint AS ledger_sum
     FROM ledger_balances`);
  const pending = await one<{ payouts: number; alerts: number }>(
    ctx.pool,
    `SELECT (SELECT count(*) FROM payouts WHERE status = 'PENDING_APPROVAL')::int AS payouts,
            (SELECT count(*) FROM compliance_alerts WHERE status = 'OPEN')::int AS alerts`);
  return {
    cycles: cycles.rows.map((c) => ({
      ...c,
      remaining: c.total_tickets - c.sold,
      // What is still owed on this cycle: unrevealed instant prizes plus undrawn final-draw cash.
      outstanding_instant_liability_kobo: c.instant_total_kobo - c.instant_revealed_kobo,
      final_draw_cash_commitment_kobo: ["DRAWN", "SETTLING", "ARCHIVED", "VOID"].includes(c.status) ? 0 : c.draw_cash_total_kobo,
    })),
    totals: { ...totals, ledger_balanced: totals?.ledger_sum === 0 },
    pending,
  };
}

export async function auditTrail(ctx: Ctx, admin: Admin, limit = 100): Promise<unknown> {
  requireRole(admin, "COMPLIANCE", "AUDITOR", "SECURITY_ADMIN");
  const rows = await ctx.pool.query(
    "SELECT seq, occurred_at, actor_type, actor_id, action, entity_type, entity_id, details FROM audit_log ORDER BY seq DESC LIMIT $1",
    [Math.min(Math.max(limit, 1), 500)]);
  const broken = await one<{ seq: number | null }>(ctx.pool, "SELECT audit_log_verify() AS seq");
  return { chainIntact: broken?.seq === null, firstBrokenSeq: broken?.seq ?? null, entries: rows.rows };
}

export async function getAdminByEmail(ctx: Ctx, email: string): Promise<{ id: string }> {
  const a = await one<{ id: string }>(ctx.pool, "SELECT id FROM admin_users WHERE email = $1", [email]);
  if (!a) throw notFound();
  return a;
}
