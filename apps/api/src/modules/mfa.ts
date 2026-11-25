import { randomBytes } from "node:crypto";
import { audit, SYSTEM } from "../audit.ts";
import type { Ctx } from "../context.ts";
import { keyedHash, sha256 } from "../crypto.ts";
import { one, withTx } from "../db.ts";
import { AppError, conflict, forbidden, unauthorized } from "../errors.ts";
import { base32Encode, matchStep } from "../totp.ts";

/**
 * Two-step sign-in for staff (SRS: administrator authentication, mandatory MFA).
 *
 * The first step (email in the simulation; single sign-on in production) gives
 * only a pending session, valid for 10 minutes and for nothing but this second
 * step. The second step is a code from an authenticator app (TOTP) — set up on
 * first sign-in — or one of ten one-time recovery codes. Each code works once.
 * Five wrong codes lock the account for 15 minutes and alert Compliance.
 */

export const MFA_MAX_FAILURES = 5;
export const MFA_LOCK_MINUTES = 15;
const ISSUER = "WiiFarm Rewards";
const ctxOf = (adminId: string) => `totp:${adminId}`;

interface Pending { adminId: string; email: string; enrolled: boolean; tokenHash: Buffer }

/** The staff member behind a pending (first-step-only) session. */
export async function pendingSession(ctx: Ctx, token: string | undefined): Promise<Pending> {
  if (!token) throw unauthorized();
  const r = await one<{ id: string; email: string; enrolled: boolean }>(ctx.pool,
    `SELECT a.id, a.email, a.totp_enabled_at IS NOT NULL AS enrolled FROM admin_sessions s JOIN admin_users a ON a.id = s.admin_user_id
     WHERE s.token_hash = $1 AND s.stage = 'MFA_PENDING' AND s.expires_at > now() AND a.status = 'ACTIVE'`, [sha256(token)]);
  if (!r) throw unauthorized("Sign in again.");
  return { adminId: r.id, email: r.email, enrolled: r.enrolled, tokenHash: sha256(token) };
}

async function activate(ctx: Ctx, p: Pending): Promise<void> {
  await ctx.pool.query("UPDATE admin_sessions SET stage = 'ACTIVE', expires_at = now() + interval '8 hours' WHERE token_hash = $1 AND stage = 'MFA_PENDING'", [p.tokenHash]);
}

async function assertNotLocked(ctx: Ctx, adminId: string): Promise<void> {
  const l = await one<{ until: Date | null }>(ctx.pool, "SELECT mfa_locked_until AS until FROM admin_users WHERE id = $1", [adminId]);
  if (l?.until && l.until.getTime() > Date.now()) {
    throw new AppError(429, "MFA_LOCKED", `Too many wrong codes. Try again after ${l.until.toISOString().slice(11, 16)} UTC, or ask a security administrator.`);
  }
}

/** Counts a wrong code; the fifth in a row locks the account and alerts Compliance. */
async function wrongCode(ctx: Ctx, adminId: string): Promise<never> {
  await withTx(ctx.pool, async (db) => {
    const r = (await one<{ n: number }>(db, "UPDATE admin_users SET mfa_failures = mfa_failures + 1 WHERE id = $1 RETURNING mfa_failures AS n", [adminId]))!;
    if (r.n >= MFA_MAX_FAILURES) {
      await db.query(`UPDATE admin_users SET mfa_failures = 0, mfa_locked_until = now() + make_interval(mins => $2) WHERE id = $1`, [adminId, MFA_LOCK_MINUTES]);
      await db.query("INSERT INTO compliance_alerts (kind, severity, entity_type, entity_id, details) VALUES ('ADMIN_MFA_LOCKED', 'CRITICAL', 'admin_user', $1, '{}')", [adminId]);
      await audit(db, SYSTEM, "access.mfa_locked", "admin_user", adminId);
    }
  });
  throw forbidden("WRONG_CODE", "That code is not correct. Use the current code from your authenticator app.");
}

/** First sign-in: a new authenticator secret, shown once, to be confirmed with a code. */
export async function startEnrolment(ctx: Ctx, p: Pending): Promise<{ secret: string; uri: string }> {
  if (p.enrolled) throw conflict("ALREADY_ENROLLED", "Two-step sign-in is already set up. Enter a code from your authenticator app.");
  const secret = randomBytes(20);
  await ctx.pool.query("UPDATE admin_users SET totp_pending_enc = $2 WHERE id = $1", [p.adminId, await ctx.keys.wrap(secret, ctxOf(p.adminId))]);
  const b32 = base32Encode(secret);
  const label = encodeURIComponent(`${ISSUER}:${p.email}`);
  return { secret: b32.replace(/(.{4})/g, "$1 ").trim(), uri: `otpauth://totp/${label}?secret=${b32}&issuer=${encodeURIComponent(ISSUER)}&algorithm=SHA1&digits=6&period=30` };
}

function newRecoveryCodes(): string[] {
  const A = "abcdefghjkmnpqrstuvwxyz23456789";
  return Array.from({ length: 10 }, () => {
    const b = randomBytes(8);
    let s = "";
    for (let i = 0; i < 8; i++) s += A[b[i]! % A.length];
    return `${s.slice(0, 4)}-${s.slice(4)}`;
  });
}
const recoveryHash = (ctx: Ctx, adminId: string, code: string) => keyedHash(ctx.config.hashKey, "admin-recovery", `${adminId}:${code.trim().toLowerCase()}`).toString("hex");

/** Confirms the authenticator with its first code; returns the recovery codes (shown once). */
export async function confirmEnrolment(ctx: Ctx, p: Pending, code: string): Promise<{ recoveryCodes: string[] }> {
  await assertNotLocked(ctx, p.adminId);
  const row = await one<{ pending: Buffer | null; enabled: Date | null }>(ctx.pool, "SELECT totp_pending_enc AS pending, totp_enabled_at AS enabled FROM admin_users WHERE id = $1", [p.adminId]);
  if (row?.enabled) throw conflict("ALREADY_ENROLLED", "Two-step sign-in is already set up.");
  if (!row?.pending) throw conflict("NOT_STARTED", "Start the set-up first.");
  const secret = await ctx.keys.unwrap(row.pending, ctxOf(p.adminId));
  const step = matchStep(secret, code);
  if (step === null) return wrongCode(ctx, p.adminId);
  const codes = newRecoveryCodes();
  await withTx(ctx.pool, async (db) => {
    await db.query(`UPDATE admin_users SET totp_secret_enc = totp_pending_enc, totp_pending_enc = NULL, totp_enabled_at = now(), totp_last_step = $2,
                    mfa_failures = 0 WHERE id = $1 AND totp_enabled_at IS NULL`, [p.adminId, step]);
    for (const c of codes) await db.query("INSERT INTO admin_recovery_codes (admin_user_id, code_hash) VALUES ($1, $2)", [p.adminId, recoveryHash(ctx, p.adminId, c)]);
    await audit(db, { type: "ADMIN", id: p.adminId }, "access.mfa_enrolled", "admin_user", p.adminId);
  });
  await activate(ctx, p);
  return { recoveryCodes: codes };
}

/** The second step on every later sign-in: an authenticator code, or a recovery code. */
export async function verifySecondStep(ctx: Ctx, p: Pending, input: { code?: string; recoveryCode?: string }): Promise<{ method: string; recoveryCodesLeft?: number }> {
  if (!p.enrolled) throw conflict("NOT_ENROLLED", "Set up two-step sign-in first.");
  await assertNotLocked(ctx, p.adminId);
  if (input.recoveryCode) {
    const used = await one(ctx.pool, "UPDATE admin_recovery_codes SET used_at = now() WHERE admin_user_id = $1 AND code_hash = $2 AND used_at IS NULL RETURNING id",
      [p.adminId, recoveryHash(ctx, p.adminId, input.recoveryCode)]);
    if (!used) return wrongCode(ctx, p.adminId);
    const left = (await one<{ n: number }>(ctx.pool, "SELECT count(*)::int AS n FROM admin_recovery_codes WHERE admin_user_id = $1 AND used_at IS NULL", [p.adminId]))!.n;
    await withTx(ctx.pool, async (db) => {
      await db.query("UPDATE admin_users SET mfa_failures = 0 WHERE id = $1", [p.adminId]);
      await audit(db, { type: "ADMIN", id: p.adminId }, "access.signed_in", "admin_user", p.adminId, { method: "RECOVERY_CODE", recoveryCodesLeft: left });
    });
    await activate(ctx, p);
    return { method: "RECOVERY_CODE", recoveryCodesLeft: left };
  }
  const row = (await one<{ enc: Buffer }>(ctx.pool, "SELECT totp_secret_enc AS enc FROM admin_users WHERE id = $1", [p.adminId]))!;
  const step = matchStep(await ctx.keys.unwrap(row.enc, ctxOf(p.adminId)), input.code ?? "");
  // A code is accepted only for a later time step than the last one used, so it cannot be replayed.
  const accepted = step !== null && await one(ctx.pool,
    "UPDATE admin_users SET totp_last_step = $2, mfa_failures = 0 WHERE id = $1 AND (totp_last_step IS NULL OR totp_last_step < $2) RETURNING id", [p.adminId, step]);
  if (!accepted) return wrongCode(ctx, p.adminId);
  await withTx(ctx.pool, (db) => audit(db, { type: "ADMIN", id: p.adminId }, "access.signed_in", "admin_user", p.adminId, { method: "TOTP" }));
  await activate(ctx, p);
  return { method: "TOTP" };
}
