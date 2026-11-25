import { fileURLToPath } from "node:url";
import { policyFromEnv, type Policy } from "./policy.ts";

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
  /**
   * Prizes worth this much or more (merchandise at advertised value), and withdrawals of this much or more,
   * need a liveness check (a live selfie matched to the verified identity) first. Default ₦100,000.
   */
  majorPrizeKobo?: number;
  /**
   * Two-step sign-in for staff. Always "required" outside simulation; a simulation may switch it
   * off (WR_ADMIN_MFA=off) for automated tests that are not about sign-in.
   */
  adminMfa?: "required" | "off";
  /** The illustrative operating-cost assumption on the central dashboard (basis points of realised revenue; the SRS uses 20%). */
  illustrativeCostBp?: number;
  /** Corporate details for the About us page (published as given; nothing is shown that has not been set). */
  company?: { name?: string; registration?: string; address?: string; email?: string };
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
  /**
   * How many proxies (load balancer, CDN) sit in front of the server. Rate limits
   * are counted per real client, read from the X-Forwarded-For header, but only
   * this many hops of it are trusted, so a client cannot forge its address.
   * 0 = the server is reached directly; the header is ignored.
   */
  trustedProxies?: number;
  /** Folder holding the player web app, served from the same origin as the API. */
  webRoot?: string;
  /** Folder holding the admin web app, served under /admin/. Production serves it from a separate, restricted address. */
  adminRoot?: string;
  /** The public address of the player app (https://…), used for link previews when it is shared. */
  publicUrl?: string;
  /** Company policy for seasons (prize shares, daily card limit, referral rate). Defaults in policy.ts. */
  policy?: Policy;
}

function keyFromEnv(name: string): Buffer {
  const v = process.env[name];
  if (!v || !/^[0-9a-f]{64}$/i.test(v)) throw new Error(`${name} must be set to 64 hex characters`);
  return Buffer.from(v, "hex");
}

/**
 * This build contains only simulated providers: email-only admin sign-in,
 * sign-in codes returned to the browser, a fake payment button, a local key
 * and a simulated randomness beacon. It must never be mistaken for a live
 * service, so it refuses to start unless simulation is explicitly switched on.
 */
export function assertSimulationAcknowledged(env: NodeJS.ProcessEnv, host: string): void {
  if (env.WR_SIMULATION !== "1") {
    throw new Error("This build runs only as a simulation (no real payments, identity checks, key service or sign-in). Set WR_SIMULATION=1 to run it.");
  }
  const local = host === "127.0.0.1" || host === "localhost" || host === "::1";
  if (!local && env.WR_ALLOW_PUBLIC_SIMULATION !== "1") {
    throw new Error(`Refusing to serve the simulation on ${host}: anyone who can reach it could sign in as any administrator by email. ` +
      "Serve it on 127.0.0.1, or set WR_ALLOW_PUBLIC_SIMULATION=1 for a closed demonstration network.");
  }
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
    majorPrizeKobo: Number(process.env.WR_MAJOR_PRIZE_KOBO ?? 10_000_000),
    adminMfa: process.env.WR_ADMIN_MFA === "off" ? "off" : "required",
    illustrativeCostBp: Number(process.env.WR_ILLUSTRATIVE_COST_BP ?? 2000),
    company: Object.fromEntries(Object.entries({ name: process.env.WR_COMPANY_NAME, registration: process.env.WR_COMPANY_RC,
      address: process.env.WR_COMPANY_ADDRESS, email: process.env.WR_COMPANY_EMAIL }).filter(([, v]) => v)),
    beaconPeriodSeconds: 30,
    sessionDays: 30,
    maxLimitsKobo: { daily: 2_000_000, weekly: 8_000_000, monthly: 20_000_000 },
    rateLimits: { auth: 20, general: 300 },
    cookieSecure: process.env.COOKIE_SECURE !== "false",
    trustedProxies: (() => {
      const v = process.env.WR_TRUSTED_PROXIES ?? "0";
      if (!/^\d{1,2}$/.test(v)) throw new Error("WR_TRUSTED_PROXIES must be the number of proxies in front of the server (0 if none)");
      return Number(v);
    })(),
    // The player web app ships with the API unless WEB_ROOT points elsewhere.
    webRoot: process.env.WEB_ROOT ?? fileURLToPath(new URL("../../web/public", import.meta.url)),
    adminRoot: process.env.ADMIN_ROOT ?? fileURLToPath(new URL("../../admin/public", import.meta.url)),
    policy: policyFromEnv(),
    ...(process.env.WR_PUBLIC_URL ? { publicUrl: (() => {
      const u = process.env.WR_PUBLIC_URL!;
      if (!/^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(u)) throw new Error("WR_PUBLIC_URL must be the https address of the player app, with no path, e.g. https://rewards.example.ng");
      return u;
    })() } : {}),
  };
}
