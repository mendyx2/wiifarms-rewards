import { timingSafeEqual } from "node:crypto";
import { notify, smsText, type Lang } from "./notify.ts";
import { ensureReferralCode, findReferrer, normaliseCode } from "./referrals.ts";
import { SYSTEM, audit, type Actor } from "../audit.ts";
import type { Ctx } from "../context.ts";
import { hashPin, keyedHash, newOtp, newToken, sha256, verifyPin } from "../crypto.ts";
import { one, withTx, type Db } from "../db.ts";
import { AppError, badRequest, conflict, forbidden, notFound, unauthorized } from "../errors.ts";

export interface User {
  id: string;
  phone_e164: string;
  full_name: string | null;
  date_of_birth: string | null;
  kyc_tier: number;
  identity_hash: Buffer | null;
  state_code: string | null;
  status: string;
  language: Lang;
}

const OTP_TTL_MINUTES = 10;
const OTP_MAX_ATTEMPTS = 5;
const OTP_MAX_SENDS_PER_HOUR = 5;
const PIN_MAX_ATTEMPTS = 5;
const PIN_LOCK_MINUTES = 15;
let DUMMY_PIN_HASH: string | undefined;

/** Accepts 0803…, 234803… or +234803… and returns +234803…. */
export function normalisePhone(input: string): string {
  const digits = input.replace(/[^\d+]/g, "");
  let e164: string;
  if (digits.startsWith("+")) e164 = digits;
  else if (digits.startsWith("234")) e164 = "+" + digits;
  else if (digits.startsWith("0")) e164 = "+234" + digits.slice(1);
  else e164 = "+234" + digits;
  if (!/^\+234[789]\d{9}$/.test(e164)) throw badRequest("INVALID_PHONE", "Enter a valid Nigerian mobile number.");
  return e164;
}

function assertPin(pin: string): void {
  if (!/^\d{6}$/.test(pin)) throw badRequest("INVALID_PIN", "Your PIN must be 6 digits.");
  if (/^(\d)\1{5}$/.test(pin) || "0123456789876543210".includes(pin)) {
    throw badRequest("WEAK_PIN", "Choose a PIN that is harder to guess.");
  }
}

// --- One-time codes -----------------------------------------------------------

export async function requestOtp(ctx: Ctx, phoneInput: string, lang: Lang = "en"): Promise<{ phone: string; devCode?: string }> {
  const phone = normalisePhone(phoneInput);
  const code = newOtp();
  const hash = keyedHash(ctx.config.hashKey, "otp", `${phone}:${code}`);
  await withTx(ctx.pool, async (db) => {
    const existing = await one<{ sends_in_window: number; window_started_at: Date }>(
      db, "SELECT sends_in_window, window_started_at FROM otp_challenges WHERE phone_e164 = $1 FOR NO KEY UPDATE", [phone]);
    const windowOpen = existing && Date.now() - existing.window_started_at.getTime() < 3600_000;
    if (windowOpen && existing.sends_in_window >= OTP_MAX_SENDS_PER_HOUR) {
      throw new AppError(429, "TOO_MANY_CODES", "Too many codes requested. Please try again in an hour.");
    }
    await db.query(
      `INSERT INTO otp_challenges (phone_e164, code_hash, expires_at)
       VALUES ($1, $2, now() + make_interval(mins => $3))
       ON CONFLICT (phone_e164) DO UPDATE SET
         code_hash = EXCLUDED.code_hash, expires_at = EXCLUDED.expires_at, attempts = 0,
         sends_in_window = CASE WHEN $4 THEN otp_challenges.sends_in_window + 1 ELSE 1 END,
         window_started_at = CASE WHEN $4 THEN otp_challenges.window_started_at ELSE now() END`,
      [phone, hash, OTP_TTL_MINUTES, Boolean(windowOpen)],
    );
  });
  // In simulation there is no SMS provider, so the code is returned to the caller.
  // Sent straight to the provider and never stored: not in the outbox, not in logs.
  try {
    await ctx.messenger.send(phone, smsText(lang === "ha"
      ? `${code} ita ce lambar WiiFarm Rewards dinka. Za ta kare cikin minti ${OTP_TTL_MINUTES}. Kada ka ba kowa ita: ba za mu taba tambayar ta ba.`
      : `${code} is your WiiFarm Rewards code. It expires in ${OTP_TTL_MINUTES} minutes. Never share it: we will never ask for it.`));
  } catch {
    throw new AppError(503, "SMS_UNAVAILABLE", "We could not send the code just now. Please try again in a minute.");
  }
  return ctx.config.simulated ? { phone, devCode: code } : { phone };
}

async function consumeOtp(ctx: Ctx, db: Db, phone: string, code: string): Promise<void> {
  const fail = badRequest("INVALID_CODE", "That code is wrong or has expired. Request a new one.");
  // The attempt is counted and committed before the code is compared, so guesses
  // are limited even when the surrounding transaction rolls back.
  const row = await one<{ code_hash: Buffer }>(
    ctx.pool,
    `UPDATE otp_challenges SET attempts = attempts + 1
     WHERE phone_e164 = $1 AND attempts < $2 AND expires_at > now() RETURNING code_hash`,
    [phone, OTP_MAX_ATTEMPTS]);
  if (!row) throw fail;
  const given = keyedHash(ctx.config.hashKey, "otp", `${phone}:${code}`);
  if (!timingSafeEqual(given, row.code_hash)) throw fail;
  const used = await db.query("DELETE FROM otp_challenges WHERE phone_e164 = $1 AND code_hash = $2", [phone, row.code_hash]);
  if (!used.rowCount) throw fail; // already used by a parallel request
}

async function createSession(ctx: Ctx, db: Db, userId: string): Promise<string> {
  const { token, hash } = newToken();
  await db.query("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now() + make_interval(days => $3))",
    [hash, userId, ctx.config.sessionDays]);
  return token;
}

/** Verifies the code and creates the account (or, for an existing number, resets the PIN). */
/** The privacy policy version a new player accepts. Change it when the policy changes; players then see the new one. */
export const PRIVACY_POLICY_VERSION = "2026-11-25";

export async function registerWithOtp(ctx: Ctx, phoneInput: string, code: string, pin: string, ip?: string, lang?: Lang, referralCode?: string,
  consent?: { privacy: boolean; marketing?: boolean }): Promise<{ token: string; userId: string }> {
  const phone = normalisePhone(phoneInput);
  assertPin(pin);
  const pinHash = await hashPin(pin);
  return withTx(ctx.pool, async (db) => {
    // An invite code only counts when a new account is opened; it is checked before the sign-up code is used up.
    const isNew = !(await one(db, "SELECT 1 FROM users WHERE phone_e164 = $1", [phone]));
    if (isNew && !consent?.privacy) throw badRequest("PRIVACY_CONSENT_REQUIRED", "Please read and accept the privacy policy to open an account.");
    // The friend whose link or code was used earns 10% of this account's card purchases (referrals.ts).
    const invite = isNew && referralCode?.trim() ? normaliseCode(referralCode) : null;
    const referrerId = invite ? await findReferrer(db, invite) : null;
    await consumeOtp(ctx, db, phone, code);
    const existing = await one<{ id: string; status: string }>(db, "SELECT id, status FROM users WHERE phone_e164 = $1 FOR NO KEY UPDATE", [phone]);
    let userId: string;
    if (existing) {
      if (existing.status !== "ACTIVE") throw forbidden("ACCOUNT_UNAVAILABLE", "This account is not available. Please contact support.");
      userId = existing.id;
      await db.query("UPDATE users SET pin_hash = $2, pin_failed_attempts = 0, pin_locked_until = NULL WHERE id = $1", [userId, pinHash]);
      // A PIN reset signs out every other device.
      await db.query("UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL", [userId]);
      await audit(db, { type: "PLAYER", id: userId, ip }, "player.pin_reset", "user", userId);
      await notify(db, { userId, kind: "SECURITY", urgent: true, link: "#/me", dedupeKey: `pin-reset:${userId}:${Date.now()}`,
        title: "Your PIN was changed", body: "Your PIN was changed and you were signed out on other devices. If this was not you, contact support at once.",
        sms: "Your PIN was just changed. If this was not you, contact support at once.",
        ha: { title: "An canja PIN ɗinka", body: "An canja PIN ɗinka kuma an fitar da kai a sauran na'urori. Idan ba kai ba ne, tuntuɓi masu taimako nan take.",
          sms: "An canja PIN ɗinka yanzu. Idan ba kai ba ne, tuntuɓi masu taimako nan take." } });
    } else {
      const created = await db.query<{ id: string }>("INSERT INTO users (phone_e164, pin_hash, language, referred_by) VALUES ($1, $2, $3, $4) RETURNING id", [phone, pinHash, lang ?? "en", referrerId]);
      userId = created.rows[0]!.id;
      await db.query("INSERT INTO rg_limits (user_id) VALUES ($1)", [userId]);
      await ensureReferralCode(db, userId); // every player can invite others from the start
      await db.query("INSERT INTO consents (user_id, kind, granted, version, ip) VALUES ($1, 'PRIVACY_POLICY', true, $2, $3), ($1, 'MARKETING', $4, $2, $3)",
        [userId, PRIVACY_POLICY_VERSION, ip ?? null, Boolean(consent?.marketing)]);
      await audit(db, { type: "PLAYER", id: userId, ip }, "player.registered", "user", userId,
        { ...(referrerId ? { referredBy: referrerId } : {}) });
      if (referrerId) await checkReferralVelocity(db, referrerId);
    }
    return { token: await createSession(ctx, db, userId), userId };
  });
}

export async function login(ctx: Ctx, phoneInput: string, pin: string, ip?: string): Promise<{ token: string; userId: string }> {
  const phone = normalisePhone(phoneInput);
  const wrong = unauthorized("Wrong phone number or PIN.");
  const user = await one<{ id: string; pin_hash: string | null; status: string; pin_locked_until: Date | null }>(
    ctx.pool, "SELECT id, pin_hash, status, pin_locked_until FROM users WHERE phone_e164 = $1", [phone]);
  if (user && user.pin_hash && user.status === "SUSPENDED" && await one(ctx.pool, "SELECT 1 FROM player_locks WHERE user_id = $1 AND lifted_at IS NULL", [user.id])) {
    // A locked account says so — but only to someone who knows the PIN, so the
    // message does not reveal to strangers which numbers have accounts.
    if (await verifyPin(pin, user.pin_hash)) throw forbidden("ACCOUNT_LOCKED", "Your account is locked for your protection. Please contact support to unlock it.");
    throw wrong;
  }
  if (!user || !user.pin_hash || user.status !== "ACTIVE") {
    // Do the same slow PIN check as for a real account, so the response time
    // does not reveal whether this phone number has an account.
    await verifyPin(pin, DUMMY_PIN_HASH ??= await hashPin("000000"));
    throw wrong;
  }
  if (user.pin_locked_until && user.pin_locked_until.getTime() > Date.now()) {
    throw new AppError(429, "PIN_LOCKED", "Too many wrong attempts. Try again in a few minutes or reset your PIN.");
  }
  if (!(await verifyPin(pin, user.pin_hash))) {
    await ctx.pool.query(
      `UPDATE users SET pin_failed_attempts = pin_failed_attempts + 1,
         pin_locked_until = CASE
           -- After ten wrong PINs in a row the account locks for a day: guessing becomes impractical.
           WHEN pin_failed_attempts + 1 >= $2 * 2 THEN now() + interval '24 hours'
           WHEN pin_failed_attempts + 1 >= $2 AND (pin_failed_attempts + 1) % $2 = 0 THEN now() + make_interval(mins => $3)
           ELSE pin_locked_until END
       WHERE id = $1`,
      [user.id, PIN_MAX_ATTEMPTS, PIN_LOCK_MINUTES]);
    throw wrong;
  }
  return withTx(ctx.pool, async (db) => {
    await db.query("UPDATE users SET pin_failed_attempts = 0, pin_locked_until = NULL WHERE id = $1", [user.id]);
    await audit(db, { type: "PLAYER", id: user.id, ip }, "player.signed_in", "user", user.id);
    return { token: await createSession(ctx, db, user.id), userId: user.id };
  });
}

/** Confirms the PIN again before a sensitive action (step-up). */
export async function confirmPin(ctx: Ctx, userId: string, pin: string): Promise<void> {
  const user = await one<{ pin_hash: string | null }>(ctx.pool, "SELECT pin_hash FROM users WHERE id = $1", [userId]);
  if (!user?.pin_hash || !(await verifyPin(pin, user.pin_hash))) throw forbidden("PIN_REQUIRED", "Enter your PIN to confirm.");
}

export async function authenticate(ctx: Ctx, token: string | undefined): Promise<User> {
  if (!token) throw unauthorized();
  const user = await one<User>(
    ctx.pool,
    `SELECT u.id, u.phone_e164, u.full_name, u.date_of_birth::text, u.kyc_tier, u.identity_hash, u.state_code, u.status, u.language
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()`,
    [sha256(token)]);
  if (!user || user.status !== "ACTIVE") throw unauthorized();
  return user;
}

/**
 * Fraud rule: an invite code bringing in an unusual number of sign-ups in a day
 * may be one person opening accounts (for example to farm rewards). Compliance is alerted
 * (once a day per code) to look before the earnings are withdrawn.
 */
export const REFERRAL_SIGNUPS_PER_DAY_ALERT = 20;
async function checkReferralVelocity(db: Db, referrerId: string): Promise<void> {
  const n = (await one<{ n: number }>(db, "SELECT count(*)::int AS n FROM users WHERE referred_by = $1 AND created_at > now() - interval '24 hours'", [referrerId]))!.n;
  if (n < REFERRAL_SIGNUPS_PER_DAY_ALERT) return;
  const recent = await one(db, "SELECT 1 FROM compliance_alerts WHERE kind = 'REFERRAL_VELOCITY' AND entity_id = $1 AND created_at > now() - interval '24 hours'", [referrerId]);
  if (recent) return;
  await db.query("INSERT INTO compliance_alerts (kind, severity, entity_type, entity_id, details) VALUES ('REFERRAL_VELOCITY', 'WARNING', 'user', $1, $2)",
    [referrerId, JSON.stringify({ signUpsIn24Hours: n })]);
}


/** The player's current consents and their history (newest first). */
export async function privacyChoices(ctx: Ctx, userId: string): Promise<unknown> {
  const rows = (await ctx.pool.query("SELECT kind, granted, version, recorded_at FROM consents WHERE user_id = $1 ORDER BY recorded_at DESC, id", [userId])).rows;
  const latest = (kind: string) => rows.find((r) => r.kind === kind) ?? null;
  return { privacyPolicy: latest("PRIVACY_POLICY"), marketing: Boolean(latest("MARKETING")?.granted), currentPolicyVersion: PRIVACY_POLICY_VERSION, history: rows };
}

/** Marketing messages can be switched on or off at any time; every change is kept. */
export async function setMarketingConsent(ctx: Ctx, actor: Actor, userId: string, granted: boolean): Promise<void> {
  await withTx(ctx.pool, async (db) => {
    await db.query("INSERT INTO consents (user_id, kind, granted, version, ip) VALUES ($1, 'MARKETING', $2, $3, $4)", [userId, granted, PRIVACY_POLICY_VERSION, actor.ip ?? null]);
    await audit(db, actor, granted ? "player.marketing_consent_given" : "player.marketing_consent_withdrawn", "user", userId);
  });
}

/** The language the player's texts and messages are written in. */
export async function setLanguage(ctx: Ctx, actor: Actor, userId: string, lang: Lang): Promise<void> {
  await withTx(ctx.pool, async (db) => {
    const r = await db.query("UPDATE users SET language = $2 WHERE id = $1 AND language <> $2", [userId, lang]);
    if (r.rowCount) await audit(db, actor, "player.language_set", "user", userId, { language: lang });
  });
}

export async function logout(ctx: Ctx, token: string): Promise<void> {
  await ctx.pool.query("UPDATE sessions SET revoked_at = now() WHERE token_hash = $1", [sha256(token)]);
}

// --- Identity verification (simulated provider) ---------------------------------

export interface KycInput {
  kind: "NIN" | "BVN";
  number: string;
  /** In production these three come back from the identity provider and device, never from the player. */
  fullName: string;
  dateOfBirth: string;
  stateCode: string;
}

function ageOn(dob: Date, today: Date): number {
  let age = today.getUTCFullYear() - dob.getUTCFullYear();
  const beforeBirthday = today.getUTCMonth() < dob.getUTCMonth() ||
    (today.getUTCMonth() === dob.getUTCMonth() && today.getUTCDate() < dob.getUTCDate());
  if (beforeBirthday) age--;
  return age;
}

export async function verifyIdentity(ctx: Ctx, userId: string, input: KycInput, ip?: string): Promise<{ kycTier: number }> {
  if (!/^\d{11}$/.test(input.number)) throw badRequest("INVALID_ID_NUMBER", "Enter the 11-digit number.");
  const dob = new Date(input.dateOfBirth + "T00:00:00Z");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.dateOfBirth) || Number.isNaN(dob.getTime())) throw badRequest("INVALID_DOB", "Invalid date of birth.");
  if (!input.fullName.trim()) throw badRequest("INVALID_NAME", "Name is required.");
  const identityHash = keyedHash(ctx.config.hashKey, "identity", `${input.kind}:${input.number}`);

  return withTx(ctx.pool, async (db) => {
    const user = await one<{ kyc_tier: number }>(db, "SELECT kyc_tier FROM users WHERE id = $1 FOR NO KEY UPDATE", [userId]);
    if (!user) throw notFound();
    if (user.kyc_tier >= 1) return { kycTier: user.kyc_tier };

    const under18 = ageOn(dob, new Date()) < 18;
    await db.query(
      `INSERT INTO kyc_verifications (user_id, kind, provider, provider_ref, result) VALUES ($1, $2, 'SIMULATED', $3, $4)`,
      [userId, input.kind, newToken().token, under18 ? "FAIL" : "PASS"]);
    if (under18) {
      await audit(db, { type: "PLAYER", id: userId, ip }, "kyc.rejected_under_18", "user", userId);
      // Committed deliberately: the failed check is part of the record.
      return { kycTier: -1 };
    }
    const taken = await one(db, "SELECT 1 FROM users WHERE identity_hash = $1 AND id <> $2", [identityHash, userId]);
    if (taken) throw conflict("IDENTITY_IN_USE", "This identity is already linked to another account. Each person can have one account.");

    await db.query(
      `UPDATE users SET kyc_tier = 1, identity_hash = $2, full_name = $3, date_of_birth = $4, state_code = $5 WHERE id = $1`,
      [userId, identityHash, input.fullName.trim(), input.dateOfBirth, input.stateCode]);
    await audit(db, { type: "PLAYER", id: userId, ip }, "kyc.verified", "user", userId, { kind: input.kind, stateCode: input.stateCode });
    return { kycTier: 1 };
  }).then((r) => {
    if (r.kycTier === -1) throw forbidden("UNDER_18", "You must be 18 or over to play.");
    return r;
  });
}

// --- Next of kin -------------------------------------------------------------------

export async function setNextOfKin(ctx: Ctx, actor: Actor, userId: string, input: { fullName: string; relationship: string; phone: string }): Promise<void> {
  const phone = normalisePhone(input.phone);
  if (!input.fullName.trim() || !input.relationship.trim()) throw badRequest("INVALID_NEXT_OF_KIN", "Name and relationship are required.");
  await withTx(ctx.pool, async (db) => {
    const openClaim = await one(db, "SELECT 1 FROM prize_claims WHERE user_id = $1 AND status IN ('ENTITLED','ON_HOLD','VERIFIED') AND stage = 'FINAL_DRAW'", [userId]);
    const existing = await one(db, "SELECT 1 FROM next_of_kin WHERE user_id = $1", [userId]);
    // Adding a next of kin for the first time is always allowed (it is needed to claim);
    // changing one while a claim is open is not, so a claim cannot be redirected.
    if (openClaim && existing) throw conflict("CLAIM_IN_PROGRESS", "Next-of-kin details cannot be changed while a prize claim is in progress.");
    await db.query(
      `INSERT INTO next_of_kin (user_id, full_name, relationship, phone_e164) VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id) DO UPDATE SET full_name = EXCLUDED.full_name, relationship = EXCLUDED.relationship, phone_e164 = EXCLUDED.phone_e164`,
      [userId, input.fullName.trim(), input.relationship.trim(), phone]);
    await audit(db, actor, "player.next_of_kin_set", "user", userId);
  });
}

// --- Responsible gaming --------------------------------------------------------------

export interface Limits {
  dailyKobo: number; weeklyKobo: number; monthlyKobo: number;
  pending?: { dailyKobo: number; weeklyKobo: number; monthlyKobo: number; effectiveAt: string };
}

/** Reads limits, first applying any requested increase whose 24-hour wait has passed. */
export async function getLimits(db: Db, userId: string): Promise<Limits> {
  await db.query(
    `UPDATE rg_limits SET daily_kobo = pending_daily_kobo, weekly_kobo = pending_weekly_kobo, monthly_kobo = pending_monthly_kobo,
       pending_daily_kobo = NULL, pending_weekly_kobo = NULL, pending_monthly_kobo = NULL, pending_effective_at = NULL, updated_at = now()
     WHERE user_id = $1 AND pending_effective_at <= now()`, [userId]);
  const r = await one<{ daily_kobo: number; weekly_kobo: number; monthly_kobo: number; pending_daily_kobo: number | null; pending_weekly_kobo: number | null; pending_monthly_kobo: number | null; pending_effective_at: Date | null }>(
    db, "SELECT * FROM rg_limits WHERE user_id = $1", [userId]);
  if (!r) throw notFound();
  const limits: Limits = { dailyKobo: r.daily_kobo, weeklyKobo: r.weekly_kobo, monthlyKobo: r.monthly_kobo };
  if (r.pending_effective_at) {
    limits.pending = { dailyKobo: r.pending_daily_kobo!, weeklyKobo: r.pending_weekly_kobo!, monthlyKobo: r.pending_monthly_kobo!, effectiveAt: r.pending_effective_at.toISOString() };
  }
  return limits;
}

/** Decreases apply at once. Any increase waits 24 hours and is capped at the company maximum. */
export async function setLimits(ctx: Ctx, actor: Actor, userId: string, want: { dailyKobo: number; weeklyKobo: number; monthlyKobo: number }): Promise<Limits> {
  const max = ctx.config.maxLimitsKobo;
  for (const v of [want.dailyKobo, want.weeklyKobo, want.monthlyKobo]) {
    if (!Number.isSafeInteger(v) || v < 0) throw badRequest("INVALID_LIMIT", "Limits must be whole amounts of zero or more.");
  }
  if (want.dailyKobo > want.weeklyKobo || want.weeklyKobo > want.monthlyKobo) {
    throw badRequest("INVALID_LIMIT", "The daily limit cannot exceed the weekly limit, nor the weekly the monthly.");
  }
  if (want.dailyKobo > max.daily || want.weeklyKobo > max.weekly || want.monthlyKobo > max.monthly) {
    throw badRequest("LIMIT_ABOVE_MAXIMUM", "That is above the maximum limit allowed.");
  }
  return withTx(ctx.pool, async (db) => {
    await db.query("SELECT 1 FROM rg_limits WHERE user_id = $1 FOR NO KEY UPDATE", [userId]);
    const cur = await getLimits(db, userId);
    // Take every decrease now; hold the whole requested set as pending if anything goes up.
    const now = {
      dailyKobo: Math.min(cur.dailyKobo, want.dailyKobo),
      weeklyKobo: Math.min(cur.weeklyKobo, want.weeklyKobo),
      monthlyKobo: Math.min(cur.monthlyKobo, want.monthlyKobo),
    };
    const increases = want.dailyKobo > cur.dailyKobo || want.weeklyKobo > cur.weeklyKobo || want.monthlyKobo > cur.monthlyKobo;
    await db.query(
      `UPDATE rg_limits SET daily_kobo = $2, weekly_kobo = $3, monthly_kobo = $4,
         pending_daily_kobo = $5, pending_weekly_kobo = $6, pending_monthly_kobo = $7,
         pending_effective_at = CASE WHEN $8 THEN now() + interval '24 hours' ELSE NULL END, updated_at = now()
       WHERE user_id = $1`,
      [userId, now.dailyKobo, now.weeklyKobo, now.monthlyKobo,
        increases ? want.dailyKobo : null, increases ? want.weeklyKobo : null, increases ? want.monthlyKobo : null, increases]);
    await audit(db, actor, "rg.limits_changed", "user", userId, { applied: now, pendingIncrease: increases ? want : null });
    return getLimits(db, userId);
  });
}

export async function selfExclude(ctx: Ctx, actor: Actor, userId: string, kind: "COOL_OFF" | "SELF_EXCLUSION", days?: number): Promise<{ endsAt: string | null }> {
  if (kind === "COOL_OFF" && (!days || !Number.isInteger(days) || days < 1 || days > 90)) {
    throw badRequest("INVALID_PERIOD", "A break can last from 1 to 90 days.");
  }
  if (kind === "SELF_EXCLUSION" && days !== undefined && (!Number.isInteger(days) || days < 180)) {
    throw badRequest("INVALID_PERIOD", "Self-exclusion lasts at least 6 months.");
  }
  return withTx(ctx.pool, async (db) => {
    const r = await db.query<{ ends_at: Date | null }>(
      `INSERT INTO self_exclusions (user_id, kind, ends_at) VALUES ($1, $2, CASE WHEN $3::int IS NULL THEN NULL ELSE now() + make_interval(days => $3::int) END)
       RETURNING ends_at`, [userId, kind, days ?? null]);
    await audit(db, actor, "rg.self_excluded", "user", userId, { kind, days: days ?? null });
    return { endsAt: r.rows[0]!.ends_at?.toISOString() ?? null };
  });
}

export async function activeExclusion(db: Db, userId: string): Promise<{ kind: string; endsAt: Date | null } | undefined> {
  const r = await one<{ kind: string; ends_at: Date | null }>(
    db, `SELECT kind, ends_at FROM self_exclusions WHERE user_id = $1 AND starts_at <= now() AND (ends_at IS NULL OR ends_at > now())
         ORDER BY ends_at DESC NULLS FIRST LIMIT 1`, [userId]);
  return r ? { kind: r.kind, endsAt: r.ends_at } : undefined;
}

/** True if the player matches the staff/family/auditor/supplier exclusion register. */
export async function onExclusionRegister(db: Db, user: Pick<User, "identity_hash" | "phone_e164">): Promise<boolean> {
  const r = await one(db,
    `SELECT 1 FROM exclusion_register WHERE active AND ((identity_hash IS NOT NULL AND identity_hash = $1) OR phone_e164 = $2) LIMIT 1`,
    [user.identity_hash, user.phone_e164]);
  return Boolean(r);
}

export async function listBankAccounts(ctx: Ctx, userId: string): Promise<unknown[]> {
  const r = await ctx.pool.query(
    `SELECT id, bank_code, resolved_name, name_match, usable_from FROM bank_accounts WHERE user_id = $1 AND status = 'ACTIVE' ORDER BY created_at`, [userId]);
  return r.rows;
}

// --- Liveness (tier 2) --------------------------------------------------------------------

export const DEFAULT_MAJOR_PRIZE_KOBO = 10_000_000; // ₦100,000

/** Thrown before a major prize claim or a large withdrawal when the liveness check has not been done. */
export const livenessRequired = () => forbidden("LIVENESS_REQUIRED", "For this amount we need to see that it is really you. Take the quick selfie check first.");

/**
 * Liveness check: a live selfie matched to the photo held for the verified
 * identity. Simulated here (the live service uses the identity provider's
 * check); raises the player to tier 2. Needed before major prizes and large
 * withdrawals, so a stolen phone and PIN are not enough to take them.
 */
export async function confirmLiveness(ctx: Ctx, actor: Actor, user: User): Promise<{ kycTier: number }> {
  if (user.kyc_tier < 1) throw forbidden("VERIFICATION_REQUIRED", "Verify your identity first.");
  if (user.kyc_tier >= 2) return { kycTier: user.kyc_tier };
  return withTx(ctx.pool, async (db) => {
    await db.query(
      "INSERT INTO kyc_verifications (user_id, kind, provider, provider_ref, result) VALUES ($1, 'LIVENESS', 'SIMULATED', $2, 'PASS')",
      [user.id, newToken().token]);
    await db.query("UPDATE users SET kyc_tier = 2 WHERE id = $1 AND kyc_tier = 1", [user.id]);
    await audit(db, actor, "kyc.liveness_passed", "user", user.id);
    return { kycTier: 2 };
  });
}

// --- Bank account (simulated name enquiry) ---------------------------------------------

export async function addBankAccount(ctx: Ctx, actor: Actor, user: User, input: { bankCode: string; accountNumber: string; accountName: string }): Promise<{ id: string; nameMatch: boolean; usableFrom: string }> {
  if (user.kyc_tier < 1 || !user.full_name) throw forbidden("VERIFICATION_REQUIRED", "Verify your identity before adding a bank account.");
  if (!/^\d{10}$/.test(input.accountNumber)) throw badRequest("INVALID_ACCOUNT", "Enter the 10-digit account number.");
  // In production accountName is what the bank returns for the account number, never what the player types.
  const norm = (s: string) => s.toLowerCase().split(/\s+/).filter(Boolean).sort().join(" ");
  const nameMatch = norm(input.accountName) === norm(user.full_name);
  const accountHash = keyedHash(ctx.config.hashKey, "bank", `${input.bankCode}:${input.accountNumber}`);
  const wrappedNumber = await ctx.keys.wrap(Buffer.from(input.accountNumber), `bank:${user.id}`);
  return withTx(ctx.pool, async (db) => {
    const r = await db.query<{ id: string; usable_from: Date }>(
      `INSERT INTO bank_accounts (user_id, bank_code, account_number_enc, account_hash, resolved_name, name_match, usable_from)
       VALUES ($1, $2, $3, $4, $5, $6, now() + make_interval(hours => $7))
       ON CONFLICT (user_id, account_hash) DO UPDATE SET status = 'ACTIVE'
       RETURNING id, usable_from`,
      [user.id, input.bankCode, wrappedNumber, accountHash, input.accountName, nameMatch, ctx.config.bankCoolingOffHours]);
    await audit(db, actor, "player.bank_account_added", "bank_account", r.rows[0]!.id, { nameMatch });
    // Fraud rule: one bank account on two players' profiles suggests one person behind several accounts
    // (for example to farm referral earnings). Compliance reviews it, and this player's withdrawals wait meanwhile.
    const others = await db.query<{ user_id: string }>(
      "SELECT DISTINCT user_id FROM bank_accounts WHERE account_hash = $1 AND user_id <> $2", [accountHash, user.id]);
    if (others.rows.length) {
      await db.query("INSERT INTO compliance_alerts (kind, severity, entity_type, entity_id, details) VALUES ('SHARED_BANK_ACCOUNT', 'CRITICAL', 'user', $1, $2)",
        [user.id, JSON.stringify({ bankAccountId: r.rows[0]!.id, alsoOn: others.rows.map((o) => o.user_id) })]);
      await audit(db, SYSTEM, "fraud.shared_bank_account", "user", user.id, { others: others.rows.length });
    }
    // Warns the real owner if someone else has got into the account and is trying to divert winnings.
    await notify(db, { userId: user.id, kind: "SECURITY", urgent: true, link: "#/wallet", dedupeKey: `bank-added:${r.rows[0]!.id}:${Date.now()}`,
      title: "Bank account added", body: `A bank account ending ${input.accountNumber.slice(-4)} was added to your account. If this was not you, contact support before it can receive winnings.`,
      sms: `A bank account ending ${input.accountNumber.slice(-4)} was added to your account. If this was not you, contact support now.`,
      ha: { title: "An ƙara asusun banki", body: `An ƙara asusun banki mai ƙarewa da ${input.accountNumber.slice(-4)} a asusunka. Idan ba kai ba ne, tuntuɓi masu taimako kafin ya karɓi kuɗin nasara.`,
        sms: `An ƙara asusun banki mai ƙarewa da ${input.accountNumber.slice(-4)} a asusunka. Idan ba kai ba ne, tuntuɓi masu taimako yanzu.` } });
    return { id: r.rows[0]!.id, nameMatch, usableFrom: r.rows[0]!.usable_from.toISOString() };
  });
}
