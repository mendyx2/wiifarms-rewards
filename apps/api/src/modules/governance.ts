import { audit } from "../audit.ts";
import type { Ctx } from "../context.ts";
import { lockKey, one, withTx, type Db } from "../db.ts";
import { badRequest, conflict, forbidden, notFound } from "../errors.ts";
import { adminActor, requireRole, type Admin, type Role } from "./admin.ts";
import { GAME_CORE_VERSION } from "./cycles.ts";

/**
 * Who can do what, and the licences and certifications that gate real money.
 *
 * Access: a security administrator creates staff accounts and requests role
 * changes; a different security administrator decides. Nobody can request or
 * decide a change to their own access. Disabling an account takes effect at
 * once and needs only one person, so a compromised account can be shut off
 * fast; re-enabling needs two. There must always be at least two active
 * security administrators, or the two-person rule itself would become
 * impossible.
 *
 * Licences and certifications: Compliance records them with their document
 * references; a different person in Compliance or Finance verifies them.
 * Only verified, unrevoked, in-date records satisfy the real-money gate, which
 * the database enforces.
 */

export const ROLES: Role[] = ["CYCLE_MANAGER", "FINANCE", "PAYOUT_APPROVER", "FULFILMENT", "SUPPORT", "COMPLIANCE", "AUDITOR", "SECURITY_ADMIN", "STOCKIST"];
const MIN_SECURITY_ADMINS = 2;

/** Mirrors the separation-of-duties rule in the database, so a request can be refused with a clear reason before anyone approves it. */
function conflictsWith(role: Role, held: Role[]): Role | undefined {
  for (const h of held) {
    if ((role === "FINANCE" && h === "PAYOUT_APPROVER") || (role === "PAYOUT_APPROVER" && h === "FINANCE")) return h;
    if ((role === "AUDITOR") !== (h === "AUDITOR")) return h;
    if ((role === "SECURITY_ADMIN") !== (h === "SECURITY_ADMIN")) return h;
    if ((role === "STOCKIST") !== (h === "STOCKIST")) return h;
  }
  return undefined;
}

const ROLE_TEXT: Record<Role, string> = {
  CYCLE_MANAGER: "cycle manager", FINANCE: "finance", PAYOUT_APPROVER: "payout approver", FULFILMENT: "fulfilment", SUPPORT: "support",
  COMPLIANCE: "compliance", AUDITOR: "auditor", SECURITY_ADMIN: "security administrator", STOCKIST: "stockist (collection centre staff)",
};

function dbRule(err: unknown): never {
  const e = err as { code?: string; message?: string; constraint?: string };
  if (e.code === "23505" && e.constraint === "admin_users_email_key") throw conflict("EMAIL_IN_USE", "There is already a staff account with that email.");
  if (e.code === "23505" && e.constraint === "admin_access_requests_one_open") throw conflict("ALREADY_REQUESTED", "The same change is already waiting for a decision.");
  if (e.code === "23000") throw conflict("RULE_VIOLATION", e.message ?? "Not allowed.");
  if (e.code === "23514") throw conflict("RULE_VIOLATION", "That is not allowed (for example, changing your own access, or deciding your own request).");
  throw err;
}

async function activeSecurityAdmins(db: Db): Promise<number> {
  return (await one<{ n: number }>(db,
    "SELECT count(*)::int AS n FROM admin_roles r JOIN admin_users a ON a.id = r.admin_user_id WHERE r.role = 'SECURITY_ADMIN' AND a.status = 'ACTIVE'"))!.n;
}

// --- Staff accounts --------------------------------------------------------------------------

export async function listStaff(ctx: Ctx, admin: Admin): Promise<unknown> {
  requireRole(admin, "SECURITY_ADMIN", "COMPLIANCE", "AUDITOR");
  const staff = (await ctx.pool.query(
    `SELECT a.id, a.email, a.full_name, a.status, a.created_at, a.disabled_at, a.stockist_id, a.totp_enabled_at IS NOT NULL AS mfa_enabled, a.mfa_locked_until,
            (SELECT st.name FROM stockists st WHERE st.id = a.stockist_id) AS stockist_name,
            coalesce(array_agg(r.role ORDER BY r.role) FILTER (WHERE r.role IS NOT NULL), '{}')::text[] AS roles,
            (SELECT max(s.created_at) FROM admin_sessions s WHERE s.admin_user_id = a.id) AS last_sign_in
     FROM admin_users a LEFT JOIN admin_roles r ON r.admin_user_id = a.id GROUP BY a.id ORDER BY a.status, a.full_name`)).rows;
  const requests = (await ctx.pool.query(
    `SELECT q.id, q.admin_user_id, t.full_name AS target_name, q.action, q.role, q.reason, q.status, q.requested_at, q.requested_by,
            rq.full_name AS requested_by_name, q.decided_at, dc.full_name AS decided_by_name, q.decision_reason
     FROM admin_access_requests q JOIN admin_users t ON t.id = q.admin_user_id JOIN admin_users rq ON rq.id = q.requested_by
     LEFT JOIN admin_users dc ON dc.id = q.decided_by ORDER BY (q.status = 'PENDING') DESC, q.requested_at DESC LIMIT 100`)).rows;
  return { staff, requests, roles: ROLES };
}

export async function createStaff(ctx: Ctx, admin: Admin, input: { email: string; fullName: string; stockistId?: string }): Promise<{ id: string }> {
  requireRole(admin, "SECURITY_ADMIN");
  const email = input.email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw badRequest("INVALID_EMAIL", "Enter a valid work email.");
  return withTx(ctx.pool, async (db) => {
    // A new account has no roles: it can sign in but do nothing until a role is granted by two people.
    // Staff of a collection centre are linked to it when the account is created; only they can later be given the stockist role.
    if (input.stockistId && !(await one(db, "SELECT 1 FROM stockists WHERE id = $1 AND status = 'ACTIVE'", [input.stockistId]))) {
      throw badRequest("INVALID_STOCKIST", "Choose an approved collection centre.");
    }
    const r = await db.query<{ id: string }>("INSERT INTO admin_users (email, full_name, stockist_id) VALUES ($1, $2, $3) RETURNING id",
      [email, input.fullName.trim(), input.stockistId ?? null]).catch(dbRule);
    await audit(db, adminActor(admin), "access.staff_created", "admin_user", r.rows[0]!.id, { email, stockistId: input.stockistId ?? null });
    return { id: r.rows[0]!.id };
  });
}

export async function requestAccessChange(ctx: Ctx, admin: Admin, input: { adminUserId: string; action: "GRANT_ROLE" | "REVOKE_ROLE" | "ENABLE" | "RESET_MFA"; role?: Role; reason: string }): Promise<{ id: string }> {
  requireRole(admin, "SECURITY_ADMIN");
  if (input.adminUserId === admin.id) throw forbidden("OWN_ACCESS", "You cannot change your own access. Ask another security administrator.");
  const roleless = input.action === "ENABLE" || input.action === "RESET_MFA";
  if (roleless !== !input.role) throw badRequest("INVALID_REQUEST", roleless ? "This change takes no role." : "Choose the role.");
  if (!input.reason.trim()) throw badRequest("REASON_REQUIRED", "Give the reason for the change.");
  return withTx(ctx.pool, async (db) => {
    const target = await one<{ status: string; roles: Role[] }>(db,
      `SELECT a.status, coalesce(array_agg(r.role) FILTER (WHERE r.role IS NOT NULL), '{}')::text[] AS roles
       FROM admin_users a LEFT JOIN admin_roles r ON r.admin_user_id = a.id WHERE a.id = $1 GROUP BY a.id`, [input.adminUserId]);
    if (!target) throw notFound("Staff account not found.");
    if (input.action === "GRANT_ROLE") {
      if (target.roles.includes(input.role!)) throw conflict("ALREADY_HELD", "They already have that role.");
      const clash = conflictsWith(input.role!, target.roles);
      if (clash) throw conflict("ROLE_CONFLICT", `The ${ROLE_TEXT[input.role!]} role cannot be held together with ${ROLE_TEXT[clash]}: one person would be able to do and approve the same thing.`);
    }
    if (input.action === "REVOKE_ROLE" && !target.roles.includes(input.role!)) throw conflict("NOT_HELD", "They do not have that role.");
    if (input.action === "ENABLE" && target.status === "ACTIVE") throw conflict("ALREADY_ACTIVE", "This account is already active.");
    if (input.action === "RESET_MFA" && !(await one(db, "SELECT 1 FROM admin_users WHERE id = $1 AND totp_enabled_at IS NOT NULL", [input.adminUserId]))) {
      throw conflict("NOT_ENROLLED", "This person has not set up two-step sign-in yet.");
    }
    const r = await db.query<{ id: string }>(
      "INSERT INTO admin_access_requests (admin_user_id, action, role, reason, requested_by) VALUES ($1, $2, $3, $4, $5) RETURNING id",
      [input.adminUserId, input.action, input.role ?? null, input.reason.trim(), admin.id]).catch(dbRule);
    await audit(db, adminActor(admin), "access.change_requested", "admin_user", input.adminUserId, { action: input.action, role: input.role ?? null, reason: input.reason });
    return { id: r.rows[0]!.id };
  });
}

export async function decideAccessChange(ctx: Ctx, admin: Admin, requestId: string, approve: boolean, reason?: string): Promise<{ status: string }> {
  requireRole(admin, "SECURITY_ADMIN");
  return withTx(ctx.pool, async (db) => {
    await lockKey(db, "access-changes"); // keeps the "at least two security administrators" count exact
    const q = await one<{ id: string; admin_user_id: string; action: string; role: Role | null; requested_by: string; status: string }>(db,
      "SELECT id, admin_user_id, action, role, requested_by, status FROM admin_access_requests WHERE id = $1 FOR UPDATE", [requestId]);
    if (!q) throw notFound("Request not found.");
    if (q.status !== "PENDING") throw conflict("ALREADY_DECIDED", "This request has already been decided.");
    if (q.requested_by === admin.id) throw forbidden("SAME_PERSON", "You made this request, so another security administrator must decide it.");
    if (q.admin_user_id === admin.id) throw forbidden("OWN_ACCESS", "You cannot decide a change to your own access.");
    if (!approve) {
      if (!reason?.trim()) throw badRequest("REASON_REQUIRED", "Give a reason for rejecting the request.");
      await db.query("UPDATE admin_access_requests SET status = 'REJECTED', decided_by = $2, decided_at = now(), decision_reason = $3 WHERE id = $1", [q.id, admin.id, reason.trim()]).catch(dbRule);
      await audit(db, adminActor(admin), "access.change_rejected", "admin_user", q.admin_user_id, { requestId: q.id, reason });
      return { status: "REJECTED" };
    }
    if (q.action === "GRANT_ROLE") {
      // The database re-checks separation of duties here and refuses conflicting roles.
      await db.query("INSERT INTO admin_roles (admin_user_id, role, granted_by) VALUES ($1, $2, $3)", [q.admin_user_id, q.role, admin.id]).catch(dbRule);
    } else if (q.action === "REVOKE_ROLE") {
      if (q.role === "SECURITY_ADMIN" && (await activeSecurityAdmins(db)) <= MIN_SECURITY_ADMINS) {
        throw conflict("LAST_SECURITY_ADMINS", `There must always be at least ${MIN_SECURITY_ADMINS} active security administrators. Appoint another first.`);
      }
      await db.query("DELETE FROM admin_roles WHERE admin_user_id = $1 AND role = $2", [q.admin_user_id, q.role]);
      await db.query("DELETE FROM admin_sessions WHERE admin_user_id = $1", [q.admin_user_id]); // sign in again with the new access
    } else if (q.action === "RESET_MFA") {
      // A lost phone: the person sets two-step sign-in up again at their next sign-in. Every session ends now.
      await db.query(`UPDATE admin_users SET totp_secret_enc = NULL, totp_pending_enc = NULL, totp_enabled_at = NULL, totp_last_step = NULL,
                      mfa_failures = 0, mfa_locked_until = NULL WHERE id = $1`, [q.admin_user_id]);
      await db.query("UPDATE admin_recovery_codes SET used_at = coalesce(used_at, now()) WHERE admin_user_id = $1", [q.admin_user_id]);
      await db.query("DELETE FROM admin_sessions WHERE admin_user_id = $1", [q.admin_user_id]);
    } else {
      await db.query("UPDATE admin_users SET status = 'ACTIVE', disabled_at = NULL, disabled_by = NULL WHERE id = $1", [q.admin_user_id]);
    }
    await db.query("UPDATE admin_access_requests SET status = 'APPROVED', decided_by = $2, decided_at = now() WHERE id = $1", [q.id, admin.id]).catch(dbRule);
    await audit(db, adminActor(admin), "access.change_approved", "admin_user", q.admin_user_id, { requestId: q.id, action: q.action, role: q.role });
    return { status: "APPROVED" };
  });
}

/** Immediate, by one security administrator: for a lost laptop, a leaver, or a suspected compromise. */
export async function disableStaff(ctx: Ctx, admin: Admin, adminUserId: string, reason: string): Promise<{ status: string }> {
  requireRole(admin, "SECURITY_ADMIN");
  if (adminUserId === admin.id) throw forbidden("OWN_ACCESS", "You cannot disable your own account.");
  if (!reason.trim()) throw badRequest("REASON_REQUIRED", "Give the reason for disabling the account.");
  return withTx(ctx.pool, async (db) => {
    await lockKey(db, "access-changes");
    const t = await one<{ status: string; is_sec: boolean }>(db,
      "SELECT a.status, EXISTS (SELECT 1 FROM admin_roles r WHERE r.admin_user_id = a.id AND r.role = 'SECURITY_ADMIN') AS is_sec FROM admin_users a WHERE a.id = $1 FOR UPDATE", [adminUserId]);
    if (!t) throw notFound("Staff account not found.");
    if (t.status === "DISABLED") throw conflict("ALREADY_DISABLED", "This account is already disabled.");
    if (t.is_sec && (await activeSecurityAdmins(db)) <= MIN_SECURITY_ADMINS) {
      throw conflict("LAST_SECURITY_ADMINS", `There must always be at least ${MIN_SECURITY_ADMINS} active security administrators. Appoint another first.`);
    }
    await db.query("UPDATE admin_users SET status = 'DISABLED', disabled_at = now(), disabled_by = $2 WHERE id = $1", [adminUserId, admin.id]);
    await db.query("DELETE FROM admin_sessions WHERE admin_user_id = $1", [adminUserId]); // signed out everywhere, at once
    await audit(db, adminActor(admin), "access.staff_disabled", "admin_user", adminUserId, { reason });
    return { status: "DISABLED" };
  });
}

// --- Licences and certifications --------------------------------------------------------------

export interface NewLicence { stateCode: string; authority: string; licenceNumber: string; validFrom: string; validTo: string; documentRef: string }
export interface NewCertification { component: "GAME_CORE" | "DRAW" | "PLATFORM_SECURITY"; componentVersion: string; lab: string; certificateRef: string; validFrom: string; validTo?: string }

const isDay = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(d + "T00:00:00Z"));

export async function recordLicence(ctx: Ctx, admin: Admin, l: NewLicence): Promise<{ id: string }> {
  requireRole(admin, "COMPLIANCE");
  if (!isDay(l.validFrom) || !isDay(l.validTo) || l.validTo <= l.validFrom) throw badRequest("INVALID_DATE", "Enter valid dates; the licence must end after it starts.");
  return withTx(ctx.pool, async (db) => {
    const r = await db.query<{ id: string }>(
      "INSERT INTO licences (state_code, authority, licence_number, valid_from, valid_to, document_ref, recorded_by) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id",
      [l.stateCode, l.authority.trim(), l.licenceNumber.trim(), l.validFrom, l.validTo, l.documentRef.trim(), admin.id])
      .catch((e: { code?: string }) => { if (e.code === "23505") throw conflict("ALREADY_RECORDED", "That licence number is already recorded for this state."); throw e; });
    await audit(db, adminActor(admin), "compliance.licence_recorded", "licence", r.rows[0]!.id, { ...l });
    return { id: r.rows[0]!.id };
  });
}

export async function recordCertification(ctx: Ctx, admin: Admin, c: NewCertification): Promise<{ id: string }> {
  requireRole(admin, "COMPLIANCE");
  if (!isDay(c.validFrom) || (c.validTo !== undefined && (!isDay(c.validTo) || c.validTo <= c.validFrom))) throw badRequest("INVALID_DATE", "Enter valid dates.");
  return withTx(ctx.pool, async (db) => {
    const r = await db.query<{ id: string }>(
      "INSERT INTO certifications (component, component_version, lab, certificate_ref, valid_from, valid_to, recorded_by) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id",
      [c.component, c.componentVersion.trim(), c.lab.trim(), c.certificateRef.trim(), c.validFrom, c.validTo ?? null, admin.id]);
    await audit(db, adminActor(admin), "compliance.certification_recorded", "certification", r.rows[0]!.id, { ...c });
    return { id: r.rows[0]!.id };
  });
}

type RecordTable = "licences" | "certifications";

export async function verifyRecord(ctx: Ctx, admin: Admin, table: RecordTable, id: string): Promise<{ status: string }> {
  requireRole(admin, "COMPLIANCE", "FINANCE");
  return withTx(ctx.pool, async (db) => {
    const r = await one<{ status: string; recorded_by: string }>(db, `SELECT status, recorded_by FROM ${table} WHERE id = $1 FOR UPDATE`, [id]);
    if (!r) throw notFound("Record not found.");
    if (r.status !== "PENDING") throw conflict("NOT_PENDING", r.status === "VERIFIED" ? "This record is already verified." : "This record has been revoked.");
    if (r.recorded_by === admin.id) throw forbidden("SAME_PERSON", "You recorded this, so someone else must check the document and verify it.");
    await db.query(`UPDATE ${table} SET status = 'VERIFIED', verified_by = $2, verified_at = now() WHERE id = $1`, [id, admin.id]).catch(dbRule);
    await audit(db, adminActor(admin), `compliance.${table === "licences" ? "licence" : "certification"}_verified`, table === "licences" ? "licence" : "certification", id);
    return { status: "VERIFIED" };
  });
}

/** Revoking is one person's decision, takes effect at once, and is reported as an alert: it can only make the gate stricter. */
export async function revokeRecord(ctx: Ctx, admin: Admin, table: RecordTable, id: string, reason: string): Promise<{ status: string }> {
  requireRole(admin, "COMPLIANCE");
  if (!reason.trim()) throw badRequest("REASON_REQUIRED", "Give the reason for revoking.");
  return withTx(ctx.pool, async (db) => {
    const r = await one<{ status: string }>(db, `SELECT status FROM ${table} WHERE id = $1 FOR UPDATE`, [id]);
    if (!r) throw notFound("Record not found.");
    if (r.status === "REVOKED") throw conflict("ALREADY_REVOKED", "This record is already revoked.");
    await db.query(`UPDATE ${table} SET status = 'REVOKED', revoked_by = $2, revoked_at = now(), revoke_reason = $3 WHERE id = $1`, [id, admin.id, reason.trim()]).catch(dbRule);
    const kind = table === "licences" ? "LICENCE_REVOKED" : "CERTIFICATION_REVOKED";
    await db.query("INSERT INTO compliance_alerts (kind, severity, entity_type, entity_id, details) VALUES ($1, 'CRITICAL', $2, $3, $4)",
      [kind, table === "licences" ? "licence" : "certification", id, JSON.stringify({ reason, note: "Check whether any real-money cycle relies on this record." })]);
    await audit(db, adminActor(admin), `compliance.${table === "licences" ? "licence" : "certification"}_revoked`, table === "licences" ? "licence" : "certification", id, { reason });
    return { status: "REVOKED" };
  });
}

export async function listRecords(ctx: Ctx, admin: Admin): Promise<unknown> {
  requireRole(admin, "COMPLIANCE", "FINANCE", "AUDITOR", "SECURITY_ADMIN");
  const cols = `x.status, x.created_at, x.verified_at, x.revoked_at, x.revoke_reason, x.recorded_by, rb.full_name AS recorded_by_name, vb.full_name AS verified_by_name`;
  const joins = `JOIN admin_users rb ON rb.id = x.recorded_by LEFT JOIN admin_users vb ON vb.id = x.verified_by`;
  const licences = (await ctx.pool.query(
    `SELECT x.id, x.state_code, x.authority, x.licence_number, x.valid_from::text, x.valid_to::text, x.document_ref, ${cols},
            (x.status = 'VERIFIED' AND current_date BETWEEN x.valid_from AND x.valid_to) AS in_force
     FROM licences x ${joins} ORDER BY x.created_at DESC`)).rows;
  const certifications = (await ctx.pool.query(
    `SELECT x.id, x.component, x.component_version, x.lab, x.certificate_ref, x.valid_from::text, x.valid_to::text, ${cols},
            (x.status = 'VERIFIED' AND current_date >= x.valid_from AND (x.valid_to IS NULL OR current_date <= x.valid_to)) AS in_force
     FROM certifications x ${joins} ORDER BY x.created_at DESC`)).rows as { component: string; component_version: string; in_force: boolean }[];
  const licenceInForce = (licences as { state_code: string; in_force: boolean }[]).some((l) => l.state_code === "NG-NI" && l.in_force);
  const engineCertified = certifications.some((c) => c.component === "GAME_CORE" && c.component_version === GAME_CORE_VERSION && c.in_force);
  return {
    licences, certifications, currentEngineVersion: GAME_CORE_VERSION,
    gate: { state: "NG-NI", licenceInForce, engineCertified,
      // Phase 2 has no real payment provider, so real-money cycles cannot be created at all, whatever this gate says.
      realMoneyAvailable: false },
  };
}
