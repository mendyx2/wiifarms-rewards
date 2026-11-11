import { fileURLToPath } from "node:url";

export interface Config {
  databaseUrl: string;
  /** 32-byte key that wraps per-cycle data keys. Stand-in for cloud KMS; never used in production as-is. */
  masterKey: Buffer;
  /** Key for the keyed hashes of NIN/BVN, bank accounts and one-time codes. */
  hashKey: Buffer;
  /** Simulated mode returns one-time codes in API responses and enables the simulated gateway and admin dev sign-in. */
  simulated: boolean;
  /** Payouts at or above this amount need a second person. Placeholder until management sets it. */
  payoutApprovalThresholdKobo: number;
  /** Hours before a newly added bank account can receive a payout. */
  bankCoolingOffHours: number;
  /** Seconds per simulated beacon round. */
  beaconPeriodSeconds: number;
  sessionDays: number;
  /** Company ceiling a player can raise their own limits to (kobo per day/week/month). */
  maxLimitsKobo: { daily: number; weekly: number; monthly: number };
  /** Requests allowed per client address per minute. */
  rateLimits: { auth: number; general: number };
  /** Session cookies are marked Secure (HTTPS only). Only ever false for local development over http. */
  cookieSecure: boolean;
  /** Folder holding the player web app, served from the same origin as the API. */
  webRoot?: string;
  /** Folder holding the admin web app, served under /admin/. Production serves it from a separate, restricted address. */
  adminRoot?: string;
}

function keyFromEnv(name: string): Buffer {
  const v = process.env[name];
  if (!v || !/^[0-9a-f]{64}$/i.test(v)) throw new Error(`${name} must be set to 64 hex characters`);
  return Buffer.from(v, "hex");
}

export function loadConfig(): Config {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL must be set");
  // Phase 2 is simulated-only. There is deliberately no setting that turns on real money.
  return {
    databaseUrl,
    masterKey: keyFromEnv("MASTER_KEY"),
    hashKey: keyFromEnv("HASH_KEY"),
    simulated: true,
    payoutApprovalThresholdKobo: Number(process.env.PAYOUT_APPROVAL_THRESHOLD_KOBO ?? 10_000_000),
    bankCoolingOffHours: Number(process.env.BANK_COOLING_OFF_HOURS ?? 24),
    beaconPeriodSeconds: 30,
    sessionDays: 30,
    maxLimitsKobo: { daily: 2_000_000, weekly: 8_000_000, monthly: 20_000_000 },
    rateLimits: { auth: 20, general: 300 },
    cookieSecure: process.env.COOKIE_SECURE !== "false",
    // The player web app ships with the API unless WEB_ROOT points elsewhere.
    webRoot: process.env.WEB_ROOT ?? fileURLToPath(new URL("../../web/public", import.meta.url)),
    adminRoot: process.env.ADMIN_ROOT ?? fileURLToPath(new URL("../../admin/public", import.meta.url)),
  };
}
