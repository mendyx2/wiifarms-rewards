// Shared set-up for browser tests: a fresh database, the real API and both web
// apps served on a random local port, demo data, and Chromium. Every page
// records script errors and failed requests so a test can insist there were none.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import pg from "pg";
import { chromium, type Browser, type Page } from "playwright";
import { SimulatedBeacon } from "@wiifarm/api/beacon.ts";
import type { Config } from "@wiifarm/api/config.ts";
import type { Ctx } from "@wiifarm/api/context.ts";
import { LocalKeyService } from "@wiifarm/api/crypto.ts";
import { createPool, type Pool } from "@wiifarm/api/db.ts";
import { buildServer } from "@wiifarm/api/http.ts";
import { SimulatedMessenger } from "@wiifarm/api/messenger.ts";
import { migrate } from "@wiifarm/api/migrate.ts";
import { seedDemo } from "@wiifarm/api/seed-demo.ts";
import { closeDueCycles } from "@wiifarm/api/modules/cycles.ts";
import { releaseExpiredHolds } from "@wiifarm/api/modules/tickets.ts";
import { deliverMessages } from "@wiifarm/api/modules/notify.ts";

const adminUrl = process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/postgres";
const root = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

export interface Stack {
  base: string; ctx: Ctx; pool: Pool; messenger: SimulatedMessenger; browser: Browser;
  /** The open demo cycle created by the seed. */
  demoCycleId: string;
  stop(): Promise<void>;
}

/** `mfa: true` runs the stack with two-step sign-in for staff, as in production; other tests switch it off. */
export async function startStack(opts: { mfa?: boolean } = {}): Promise<Stack> {
  const dbName = "wr_browser_" + randomBytes(4).toString("hex");
  const dbUrl = (() => { const u = new URL(adminUrl); u.pathname = "/" + dbName; return u.toString(); })();
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect(); await admin.query(`CREATE DATABASE ${dbName}`); await admin.end();
  await migrate(dbUrl);
  const pool = createPool(dbUrl);
  const config: Config = {
    databaseUrl: dbUrl, masterKey: randomBytes(32), hashKey: randomBytes(32), simulated: true,
    payoutApprovalThresholdKobo: 500_000, bankCoolingOffHours: 0, beaconPeriodSeconds: 1, sessionDays: 30,
    maxLimitsKobo: { daily: 2_000_000, weekly: 8_000_000, monthly: 20_000_000 }, rateLimits: { auth: 100_000, general: 1_000_000 },
    cookieSecure: false, webRoot: root("../../web/public"), adminRoot: root("../../admin/public"), adminMfa: opts.mfa ? "required" : "off",
  };
  const messenger = new SimulatedMessenger();
  const ctx: Ctx = { pool, config, keys: new LocalKeyService(config.masterKey), beacon: new SimulatedBeacon(pool, 1), messenger };
  const { cycleId } = await seedDemo(ctx);
  const app = buildServer(ctx);
  await app.listen({ port: 0, host: "127.0.0.1" });
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const browser = await chromium.launch();
  // The same background jobs the real server runs (closing cycles on time, sending texts), sped up.
  const jobs = setInterval(() => {
    closeDueCycles(ctx).catch(() => {});
    releaseExpiredHolds(ctx).catch(() => {});
    deliverMessages(ctx).catch(() => {});
  }, 1000);
  return {
    base, ctx, pool, messenger, browser, demoCycleId: cycleId,
    async stop() {
      clearInterval(jobs);
      await browser.close();
      await app.close();
      await pool.end();
      const c = new pg.Client({ connectionString: adminUrl });
      await c.connect(); await c.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`); await c.end();
    },
  };
}

// --- Pages ---------------------------------------------------------------------------------

const problems = new WeakMap<Page, string[]>();

export async function newPage(s: Stack, size: "phone" | "desktop" = "phone"): Promise<Page> {
  const context = await s.browser.newContext({ viewport: size === "phone" ? { width: 400, height: 860 } : { width: 1280, height: 900 }, acceptDownloads: true });
  const page = await context.newPage();
  const list: string[] = [];
  problems.set(page, list);
  page.on("pageerror", (e) => list.push("script error: " + e.message));
  page.on("response", (r) => { if (r.status() >= 500) list.push(`server error ${r.status()} ${r.url()}`); });
  return page;
}

/** No script errors, no server errors, and nothing wider than the screen. */
export async function assertClean(page: Page, label: string): Promise<void> {
  assert.deepEqual(problems.get(page) ?? [], [], `${label}: problems on the page`);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false, `${label}: page scrolls sideways`);
}

/** Checks each screen at small-phone width for sideways scrolling and errors. */
export async function assertFits(page: Page, url: string, routes: string[], waitFor: string, width = 320): Promise<void> {
  const before = page.viewportSize()!;
  await page.setViewportSize({ width, height: 760 });
  for (const r of routes) {
    await page.goto(url + r);
    await page.waitForSelector(waitFor);
    await page.waitForLoadState("networkidle");
    await assertClean(page, `${r} at ${width}px`);
  }
  await page.setViewportSize(before);
}

/** Answers browser confirm() with OK and prompt() with the given text. */
export function answerDialogs(page: Page, answer: () => string = () => "Reason given in test"): void {
  page.on("dialog", (d) => (d.type() === "prompt" ? d.accept(answer()) : d.accept()));
}

/**
 * Reads and clears the toast message. With `expected`, waits for a toast that
 * matches it (an earlier message may still be fading out).
 */
export async function toast(page: Page, expected?: RegExp): Promise<string> {
  if (expected) {
    await page.waitForFunction((src) => { const t = document.getElementById("toast")!; return t.classList.contains("on") && new RegExp(src).test(t.textContent ?? ""); }, expected.source);
  }
  await page.waitForSelector(".toast.on");
  const text = await page.innerText("#toast");
  await page.evaluate(() => document.getElementById("toast")!.classList.remove("on"));
  return text;
}

export async function adminSignIn(page: Page, s: Stack, who: string): Promise<void> {
  await page.goto(s.base + "/admin");
  if (await page.locator("#signOut").isVisible().catch(() => false)) {
    await page.click("#signOut");
  }
  await page.waitForSelector("input[name=email]");
  await page.fill("input[name=email]", `${who}@demo.wiifarm.test`);
  await page.click('button:has-text("Sign in")');
  await page.waitForFunction((n) => document.getElementById("whoName")?.textContent?.toLowerCase().includes(n), who);
}

export async function playerSignIn(page: Page, s: Stack, phone: string, pin = "482915"): Promise<void> {
  await page.goto(s.base + "/#/login");
  await page.waitForSelector("input[name=pin]");
  await page.fill("input[name=phone]", phone);
  await page.fill("input[name=pin]", pin);
  await page.click('button:has-text("Sign in")');
  await page.waitForSelector(".hero");
}

/** Drags across the scratch surface the way a finger would. */
export async function scratch(page: Page): Promise<void> {
  await page.waitForSelector("canvas");
  await page.waitForTimeout(150);
  const box = (await page.locator("canvas").boundingBox())!;
  await page.mouse.move(box.x + 10, box.y + 10);
  await page.mouse.down();
  for (let y = 15; y < box.height; y += 30) for (let x = 10; x < box.width; x += 20) await page.mouse.move(box.x + x, box.y + y);
  await page.mouse.up();
}

// --- Direct API calls (for set-up that is not under test) ----------------------------------------

export async function call(s: Stack, method: string, path: string, opts: { token?: string; body?: unknown; key?: string } = {}): Promise<any> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  if (opts.token) headers.authorization = "Bearer " + opts.token;
  if (opts.key) headers["idempotency-key"] = opts.key;
  const r = await fetch(s.base + path, opts.body === undefined ? { method, headers } : { method, headers, body: JSON.stringify(opts.body) });
  const data = await r.json();
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${JSON.stringify(data)}`);
  return data;
}

export async function adminToken(s: Stack, who: string): Promise<string> {
  return (await call(s, "POST", "/v1/admin/dev-login", { body: { email: `${who}@demo.wiifarm.test` } })).token;
}

let ninSeq = 0;
/** A verified Niger State player created through the API. */
export async function apiPlayer(s: Stack, phone: string, name = "Test Player", referralCode?: string): Promise<{ token: string; phone: string }> {
  const otp = await call(s, "POST", "/v1/auth/otp", { body: { phone } });
  const { token } = await call(s, "POST", "/v1/auth/register", { body: { phone, code: otp.devCode, pin: "482915", acceptPrivacy: true, ...(referralCode ? { referralCode } : {}) } });
  await call(s, "POST", "/v1/me/verify", { token, body: { kind: "NIN", number: String(30_000_000_000 + ++ninSeq + Math.floor(Math.random() * 1e6) * 100), fullName: name, dateOfBirth: "1990-01-01", stateCode: "NG-NI" } });
  return { token, phone };
}

export async function apiBuy(s: Stack, token: string, cycleId: string, quantity: number): Promise<void> {
  await call(s, "POST", `/v1/cycles/${cycleId}/rules/accept`, { token });
  const order = await call(s, "POST", "/v1/orders", { token, key: "k" + randomBytes(8).toString("hex"), body: { cycleId, quantity } });
  await call(s, "POST", "/v1/simulated-gateway/pay", { token, body: { paymentRef: order.paymentRef } });
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Opens a screen fresh, even if the browser is already on that address (a plain goto would do nothing). */
export async function visit(page: Page, url: string): Promise<void> {
  if (page.url() === url) await page.reload();
  else await page.goto(url);
}

/** Every string the server sent as data (not error messages), so they can be told apart from the app's own text. */
export function watchServerData(page: Page): Set<string> {
  const seen = new Set<string>();
  const walk = (v: unknown, key = ""): void => {
    if (key === "error") return;
    if (typeof v === "string") seen.add(v);
    else if (Array.isArray(v)) v.forEach((x) => walk(x));
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, k);
  };
  page.on("response", async (r) => {
    if (!r.url().includes("/v1/") || !(r.headers()["content-type"] ?? "").includes("json")) return;
    try { walk(await r.json()); } catch { /* not JSON */ }
  });
  return seen;
}

/** English text the player app showed in Hausa mode, other than server data. */
export async function untranslated(page: Page, serverData: Set<string>): Promise<string[]> {
  const missing: string[] = await page.evaluate(() => [...((window as any).__i18nMissing as Set<string>)]);
  return missing.filter((t) => !serverData.has(t) && !serverData.has(t.trim()));
}

/** A small season with one merchandise prize, run to its draw through the API (not what is under test here). */
export async function wonPrize(s: Stack, token: string): Promise<string> {
  const [ft, mt, ot, fin, aud] = await Promise.all(["fulfilment", "manager", "operations", "finance", "auditor"].map((w) => adminToken(s, w))) as [string, string, string, string, string];
  const supplier = (await call(s, "POST", "/v1/admin/suppliers", { token: ft, body: { name: "Rice Mill" } })).id;
  const warehouse = (await call(s, "POST", "/v1/admin/warehouses", { token: ft, body: { name: "Store", address: "1 Store Road, Minna", stateCode: "NG-NI" } })).id;
  const sku = (await call(s, "POST", "/v1/admin/skus", { token: ft, body: { name: "Rice 50kg bag", advertisedValueKobo: 500_000, serialised: true } })).id;
  await call(s, "POST", "/v1/admin/stock/receive", { token: ft, body: { skuId: sku, supplierId: supplier, warehouseId: warehouse, poReference: "PO-RICE", serialNumbers: ["RICE-001"], acquisitionCostKobo: 1, landedCostKobo: 1 } });
  const now = Date.now(), close = new Date(now + 15_000).toISOString();
  const c = (await call(s, "POST", "/v1/admin/cycles", { token: mt, body: { name: "Rice Season", ticketPriceKobo: 50_000, totalTickets: 20, maxTicketsPerAccount: 20,
    salesOpenAt: new Date(now - 1000).toISOString(), salesCloseAt: close, drawAt: close } })).id;
  await call(s, "POST", `/v1/admin/cycles/${c}/prize-tiers`, { token: mt, body: { stage: "FINAL_DRAW", kind: "MERCHANDISE", title: "Rice 50kg bag", skuId: sku, quantity: 1, drawOrder: 1 } });
  const auditorId = (await call(s, "GET", "/v1/admin/auditors", { token: mt })).auditors[0].id;
  await call(s, "PUT", `/v1/admin/cycles/${c}/evidence`, { token: mt, body: { financialModelRef: "fm", rulesDocumentRef: "rules", rulesText: "Rice Season rules.",
    escrowReference: "ESC", escrowFundedKobo: 0, auditorAdminId: auditorId } });
  await call(s, "POST", `/v1/admin/cycles/${c}/reserve-stock`, { token: ft });
  await call(s, "POST", `/v1/admin/cycles/${c}/submit`, { token: mt });
  await call(s, "POST", `/v1/admin/cycles/${c}/approve`, { token: ot });
  await call(s, "POST", `/v1/admin/cycles/${c}/approve`, { token: fin });
  await call(s, "POST", `/v1/admin/cycles/${c}/commit`, { token: mt });
  await call(s, "POST", `/v1/admin/cycles/${c}/open`, { token: mt });
  await apiBuy(s, token, c, 5);
  await call(s, "PUT", "/v1/me/next-of-kin", { token, body: { fullName: "Musa Kin", relationship: "Brother", phone: "08030004444" } });
  await sleep(Math.max(0, Date.parse(close) - Date.now()) + 2500);
  for (const t of [mt, fin, aud]) await call(s, "POST", `/v1/admin/cycles/${c}/draw/sign`, { token: t });
  await call(s, "POST", `/v1/admin/cycles/${c}/draw/execute`, { token: mt });
  return c;
}

