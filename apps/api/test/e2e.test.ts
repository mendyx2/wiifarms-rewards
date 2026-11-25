// End-to-end test of a whole simulated prize cycle against a real PostgreSQL.
// Needs TEST_DATABASE_URL pointing at a server where it may create a database.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import pg from "pg";
import type { FastifyInstance } from "fastify";
import { MerkleTree, deriveDrawSeed, entriesHash, runDraw, ticketLeafHash, verifySecretCommitment, verifyTicket } from "@wiifarm/game-core";
import { SimulatedBeacon } from "../src/beacon.ts";
import type { Config } from "../src/config.ts";
import type { Ctx } from "../src/context.ts";
import { LocalKeyService } from "../src/crypto.ts";
import { createPool, type Pool } from "../src/db.ts";
import { POLICY } from "../src/policy.ts";
import { buildServer } from "../src/http.ts";
import { migrate } from "../src/migrate.ts";
import { SimulatedMessenger } from "../src/messenger.ts";
import { deliverMessages, nextSendTime, sendClaimReminders } from "../src/modules/notify.ts";
import { GAME_CORE_VERSION, closeDueCycles } from "../src/modules/cycles.ts";
import { assertSimulationAcknowledged } from "../src/config.ts";

const adminUrl = process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/postgres";
const dbName = "wr_test_" + randomBytes(4).toString("hex");
const dbUrl = (() => { const u = new URL(adminUrl); u.pathname = "/" + dbName; return u.toString(); })();

let pool: Pool, app: FastifyInstance, ctx: Ctx, config: Config, messenger: SimulatedMessenger;
const N200 = 20_000; // ₦200 in kobo

interface Res { status: number; body: any }
async function api(method: "GET" | "POST" | "PUT", url: string, opts: { token?: string | undefined; body?: unknown; key?: string; raw?: boolean } = {}, server = app): Promise<Res> {
  // Players in these tests do what the app makes them do: accept the privacy policy when signing up, and a
  // campaign's game rules before buying. (The "compliance basics" test checks both with raw: true.)
  if (!opts.raw && method === "POST" && url === "/v1/auth/register" && opts.body && !("acceptPrivacy" in (opts.body as object))) {
    opts = { ...opts, body: { ...(opts.body as object), acceptPrivacy: true } };
  }
  if (!opts.raw && method === "POST" && url === "/v1/orders" && opts.token && (opts.body as { cycleId?: string })?.cycleId) {
    await api("POST", `/v1/cycles/${(opts.body as { cycleId: string }).cycleId}/rules/accept`, { token: opts.token, raw: true }, server);
  }
  const headers: Record<string, string> = {};
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.key) headers["idempotency-key"] = opts.key;
  const r = await server.inject({ method, url, headers, ...(opts.body === undefined ? {} : { payload: opts.body as object }) });
  return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null };
}
const ok = (r: Res, status = 200): any => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const fails = (r: Res, status: number, code: string): void => { assert.equal(r.status, status, JSON.stringify(r.body)); assert.equal(r.body.error.code, code); };
const key = () => randomUUID();

const admins: Record<string, { id: string; token: string }> = {};
let phoneSeq = 0;
interface Player { token: string; phone: string; pin: string; id: string }

async function newPlayer(opts: { verify?: boolean; state?: string; dob?: string; name?: string } = {}): Promise<Player> {
  const seq = ++phoneSeq; // taken once: several players may be created in parallel
  const phone = "0803" + String(1000000 + seq);
  const pin = "482915";
  const otp = ok(await api("POST", "/v1/auth/otp", { body: { phone } }));
  const reg = ok(await api("POST", "/v1/auth/register", { body: { phone, code: otp.devCode, pin } }));
  const p: Player = { token: reg.token, phone, pin, id: reg.userId };
  if (opts.verify !== false) {
    ok(await api("POST", "/v1/me/verify", { token: p.token, body: {
      kind: "NIN", number: String(10000000000 + seq), fullName: opts.name ?? `Test Player ${seq}`,
      dateOfBirth: opts.dob ?? "1990-05-17", stateCode: opts.state ?? "NG-NI" } }));
  }
  return p;
}

async function buy(p: Player, cycleId: string, quantity: number): Promise<any> {
  const order = ok(await api("POST", "/v1/orders", { token: p.token, key: key(), body: { cycleId, quantity } }));
  return ok(await api("POST", "/v1/simulated-gateway/pay", { token: p.token, body: { paymentRef: order.paymentRef } }));
}

/** An approved collection centre in Minna (registered by Fulfilment, approved by Compliance), created once. */
let centreId: string | undefined;
async function centre(): Promise<string> {
  if (centreId) return centreId;
  const r = ok(await api("POST", "/v1/admin/stockists", { token: admins.fulfilment!.token, body: {
    name: "Minna Central Stockist", tier: "MEGA", stateCode: "NG-NI", area: "Minna", address: "Plot 4, Paiko Road, Minna", phone: "08030001111",
    coverage: ["Chanchaga", "Bosso"], openingHours: "Mon–Sat 8am–6pm", feeKobo: 50_000 } }));
  ok(await api("POST", `/v1/admin/stockists/${r.id}/decision`, { token: admins.compliance!.token, body: { decision: "APPROVE" } }));
  return (centreId = r.id);
}

/** Creates a cycle and takes it through approval, commitment and opening. */
/**
 * Standard test season: ₦200 cards and a prize table that fits the real budget
 * (prizes from 50% of full sell-out sales, 10% of that as instant cash).
 * 60 cards: one ₦500 instant win; final draw ₦2,000 cash and two freezers.
 * Under 100 cards there is no room for an instant win; the draw cash is ₦1,000.
 */
async function openCycle(o: { total: number; closeInMs: number; cap: number; name: string; priceKobo?: number;
  tiers?: object[]; escrowKobo?: number; levels?: number }): Promise<{ id: string; closeAt: number }> {
  const now = Date.now();
  const closeAt = now + o.closeInMs;
  const price = o.priceKobo ?? N200;
  const c = ok(await api("POST", "/v1/admin/cycles", { token: admins.manager!.token, body: {
    name: o.name, ticketPriceKobo: price, totalTickets: o.total, maxTicketsPerAccount: o.cap, ...(o.levels ? { levels: o.levels } : {}),
    salesOpenAt: new Date(now - 1000).toISOString(), salesCloseAt: new Date(closeAt).toISOString(), drawAt: new Date(closeAt).toISOString() } }));
  const tier = (b: object) => api("POST", `/v1/admin/cycles/${c.id}/prize-tiers`, { token: admins.manager!.token, body: b });
  const instantBudget = Math.floor(Math.floor(o.total * price / 2) / 10);
  const instantWins = Math.floor(instantBudget / 50_000);
  const drawCash = o.total >= 60 ? 200_000 : 100_000;
  const tiers = o.tiers ?? [
    ...(instantWins ? [{ stage: "INSTANT", kind: "CASH", title: "₦500", cashKobo: 50_000, quantity: instantWins }] : []),
    { stage: "FINAL_DRAW", kind: "CASH", title: `₦${(drawCash / 100).toLocaleString("en-NG")} cash`, cashKobo: drawCash, quantity: 1, drawOrder: 1 },
    { stage: "FINAL_DRAW", kind: "MERCHANDISE", title: "Solar freezer", skuId: skuId, quantity: 2, drawOrder: 2 },
  ];
  for (const t of tiers) ok(await tier(t));
  const escrow = o.escrowKobo ?? (instantWins * 50_000 + drawCash);
  ok(await api("PUT", `/v1/admin/cycles/${c.id}/evidence`, { token: admins.manager!.token, body: {
    financialModelRef: "fm-1", rulesDocumentRef: "rules-1", rulesText: "Published rules", escrowReference: "ESC-1",
    escrowFundedKobo: escrow, auditorAdminId: admins.auditor!.id } }));
  assert.equal(ok(await api("POST", `/v1/admin/cycles/${c.id}/reserve-stock`, { token: admins.fulfilment!.token })).complete, true);
  ok(await api("POST", `/v1/admin/cycles/${c.id}/submit`, { token: admins.manager!.token }));
  ok(await api("POST", `/v1/admin/cycles/${c.id}/approve`, { token: admins.manager2!.token }));
  assert.equal(ok(await api("POST", `/v1/admin/cycles/${c.id}/approve`, { token: admins.finance!.token })).status, "APPROVED");
  ok(await api("POST", `/v1/admin/cycles/${c.id}/commit`, { token: admins.manager!.token }));
  ok(await api("POST", `/v1/admin/cycles/${c.id}/open`, { token: admins.manager!.token }));
  return { id: c.id, closeAt };
}

let skuId: string, supplierId: string, warehouseId: string;
let cycleA: { id: string; closeAt: number };
let players: Player[] = [];

before(async () => {
  const root = new pg.Client({ connectionString: adminUrl });
  await root.connect();
  await root.query(`CREATE DATABASE ${dbName}`);
  await root.end();
  await migrate(dbUrl);
  pool = createPool(dbUrl);
  config = {
    databaseUrl: dbUrl, masterKey: randomBytes(32), hashKey: randomBytes(32), simulated: true,
    payoutApprovalThresholdKobo: 100_000, bankCoolingOffHours: 0, beaconPeriodSeconds: 1, sessionDays: 30,
    maxLimitsKobo: { daily: 2_000_000, weekly: 8_000_000, monthly: 20_000_000 }, rateLimits: { auth: 100_000, general: 1_000_000 }, cookieSecure: true,
    // Real prize shares; a higher daily card limit so the older tests can buy 20 cards at once (the 10-a-day default has its own test).
    // The older test seasons were sized for a 10% instant share; the real policy (5%) has its own test.
    policy: { ...POLICY, instantShareBp: 1000, cardsPerDay: 30 },
  };
  messenger = new SimulatedMessenger();
  ctx = { pool, config, keys: new LocalKeyService(config.masterKey), beacon: new SimulatedBeacon(pool, config.beaconPeriodSeconds), messenger };
  app = buildServer(ctx);

  const roles: Record<string, string> = { manager: "CYCLE_MANAGER", manager2: "CYCLE_MANAGER", finance: "FINANCE", approver: "PAYOUT_APPROVER", fulfilment: "FULFILMENT", support: "SUPPORT", compliance: "COMPLIANCE", compliance2: "COMPLIANCE", auditor: "AUDITOR", auditor2: "AUDITOR", security: "SECURITY_ADMIN", security2: "SECURITY_ADMIN" };
  const ids: Record<string, string> = {};
  for (const name of Object.keys(roles)) {
    ids[name] = (await pool.query("INSERT INTO admin_users (email, full_name) VALUES ($1, $2) RETURNING id", [`${name}@example.test`, name])).rows[0].id;
  }
  for (const [name, role] of Object.entries(roles)) {
    await pool.query("INSERT INTO admin_roles (admin_user_id, role, granted_by) VALUES ($1, $2, $3)", [ids[name], role, name === "security" ? ids.security2 : ids.security]);
    admins[name] = { id: ids[name]!, token: ok(await api("POST", "/v1/admin/dev-login", { body: { email: `${name}@example.test` } })).token };
  }
  // Merchandise set up by Fulfilment: item, supplier, warehouse, and serial-numbered stock with costs.
  const ft = admins.fulfilment!.token;
  skuId = ok(await api("POST", "/v1/admin/skus", { token: ft, body: { name: "Solar freezer 200L", advertisedValueKobo: 50_000, serialised: true, warrantyMonths: 24 } })).id;
  supplierId = ok(await api("POST", "/v1/admin/suppliers", { token: ft, body: { name: "Test Supplier", country: "NG" } })).id;
  warehouseId = ok(await api("POST", "/v1/admin/warehouses", { token: ft, body: { name: "Minna", address: "1 Test Road, Minna", stateCode: "NG-NI" } })).id;
  ok(await api("POST", "/v1/admin/stock/receive", { token: ft, body: { skuId, supplierId, warehouseId, poReference: "PO-1", serialNumbers: ["SN-1", "SN-2", "SN-3", "SN-4", "SN-5"], acquisitionCostKobo: 30_000, landedCostKobo: 40_000 } }));
});

after(async () => {
  await app?.close();
  await pool?.end();
  const root = new pg.Client({ connectionString: adminUrl });
  await root.connect();
  await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await root.end();
});

test("sign-up: codes, PIN rules, sign-in and lockout", async () => {
  const phone = "08039990001";
  const otp = ok(await api("POST", "/v1/auth/otp", { body: { phone } }));
  fails(await api("POST", "/v1/auth/register", { body: { phone, code: otp.devCode, pin: "111111" } }), 400, "WEAK_PIN");
  fails(await api("POST", "/v1/auth/register", { body: { phone, code: otp.devCode === "000000" ? "000001" : "000000", pin: "482915" } }), 400, "INVALID_CODE");
  const reg = ok(await api("POST", "/v1/auth/register", { body: { phone, code: otp.devCode, pin: "482915" } }));
  // A used code cannot be used again.
  fails(await api("POST", "/v1/auth/register", { body: { phone, code: otp.devCode, pin: "482915" } }), 400, "INVALID_CODE");
  assert.equal(ok(await api("GET", "/v1/me", { token: reg.token })).kycTier, 0);
  fails(await api("GET", "/v1/me"), 401, "UNAUTHENTICATED");
  fails(await api("GET", "/v1/me", { token: "not-a-token" }), 401, "UNAUTHENTICATED");
  ok(await api("POST", "/v1/auth/login", { body: { phone, pin: "482915" } }));
  for (let i = 0; i < 5; i++) fails(await api("POST", "/v1/auth/login", { body: { phone, pin: "000001" } }), 401, "UNAUTHENTICATED");
  fails(await api("POST", "/v1/auth/login", { body: { phone, pin: "482915" } }), 429, "PIN_LOCKED");
  let lock = (await pool.query("SELECT pin_locked_until - now() AS left FROM users WHERE phone_e164 = '+2348039990001'")).rows[0].left;
  assert.ok(lock.minutes >= 14 && !lock.hours, "first lock: 15 minutes");
  // After the 15 minutes, five more wrong guesses lock the account for a whole day.
  await pool.query("UPDATE users SET pin_locked_until = now() - interval '1 second' WHERE phone_e164 = '+2348039990001'");
  for (let i = 0; i < 5; i++) fails(await api("POST", "/v1/auth/login", { body: { phone, pin: "000002" } }), 401, "UNAUTHENTICATED");
  lock = (await pool.query("SELECT pin_locked_until - now() AS left FROM users WHERE phone_e164 = '+2348039990001'")).rows[0].left;
  assert.ok(lock.hours >= 23, "second lock: 24 hours");
  fails(await api("POST", "/v1/auth/login", { body: { phone, pin: "482915" } }), 429, "PIN_LOCKED");
  // An unknown number takes as long to refuse as a real one, so timing does not reveal who has an account.
  const real = await newPlayer({ verify: false });
  const time = async (ph: string) => { const t = performance.now(); await api("POST", "/v1/auth/login", { body: { phone: ph, pin: "000003" } }); return performance.now() - t; };
  await time("08031239999"); // warm-up
  const known = Math.min(await time(real.phone), await time(real.phone));
  const unknown = Math.min(await time("08031239998"), await time("08031239997"));
  assert.ok(unknown > known * 0.5, `unknown ${unknown.toFixed(0)} ms vs known ${known.toFixed(0)} ms`);
  fails(await api("POST", "/v1/auth/otp", { body: { phone: "12345" } }), 400, "INVALID_PHONE");
  fails(await api("POST", "/v1/auth/otp", { body: { phone, extra: "x" } }), 400, "INVALID_REQUEST");
  // Nothing sensitive is stored in the clear.
  const row = (await pool.query("SELECT pin_hash FROM users WHERE phone_e164 = '+2348039990001'")).rows[0];
  assert.ok(!row.pin_hash.includes("482915"));
  const sess = (await pool.query("SELECT token_hash FROM sessions LIMIT 1")).rows[0];
  assert.notEqual(sess.token_hash.toString("base64url"), reg.token);
});

test("identity: under-18 refused, one account per person", async () => {
  const kid = await newPlayer({ verify: false });
  const year = new Date().getUTCFullYear() - 17;
  fails(await api("POST", "/v1/me/verify", { token: kid.token, body: { kind: "NIN", number: "55555555555", fullName: "Young Person", dateOfBirth: `${year}-12-31`, stateCode: "NG-NI" } }), 403, "UNDER_18");
  const a = await newPlayer({ verify: false }), b = await newPlayer({ verify: false });
  const idBody = { kind: "BVN", number: "22222222222", fullName: "Same Person", dateOfBirth: "1985-01-01", stateCode: "NG-NI" };
  ok(await api("POST", "/v1/me/verify", { token: a.token, body: idBody }));
  fails(await api("POST", "/v1/me/verify", { token: b.token, body: idBody }), 409, "IDENTITY_IN_USE");
  // The identity number itself is not stored anywhere.
  const dump = JSON.stringify((await pool.query("SELECT * FROM users")).rows) + JSON.stringify((await pool.query("SELECT * FROM kyc_verifications")).rows);
  assert.ok(!dump.includes("22222222222"));
});

test("cycle approval: separation of duties, funding, locking, commitments", async () => {
  const now = Date.now();
  const mk = (b: object) => api("POST", "/v1/admin/cycles", { token: admins.manager!.token, body: { name: "Rules check", ticketPriceKobo: N200, totalTickets: 100, maxTicketsPerAccount: 5, salesOpenAt: new Date(now - 1000).toISOString(), salesCloseAt: new Date(now + 3600_000).toISOString(), drawAt: new Date(now + 3600_000).toISOString(), ...b } });
  fails(await mk({ ticketPriceKobo: 10_000 }), 400, "INVALID_PRICE");
  fails(await api("POST", "/v1/admin/cycles", { token: admins.finance!.token, body: {} }), 400, "INVALID_REQUEST");
  fails(await api("POST", "/v1/admin/cycles", { token: admins.finance!.token, body: { name: "x", ticketPriceKobo: N200, totalTickets: 20, maxTicketsPerAccount: 5, salesOpenAt: "2030-01-01", salesCloseAt: "2030-01-02", drawAt: "2030-01-03" } }), 403, "ROLE_REQUIRED");
  const c = ok(await mk({}));
  const url = `/v1/admin/cycles/${c.id}`;
  fails(await api("POST", `${url}/prize-tiers`, { token: admins.manager!.token, body: { stage: "INSTANT", kind: "CASH", title: "too big", cashKobo: 5_000_000, quantity: 1 } }), 400, "INVALID_PRIZE");
  ok(await api("POST", `${url}/prize-tiers`, { token: admins.manager!.token, body: { stage: "INSTANT", kind: "CASH", title: "₦500", cashKobo: 50_000, quantity: 2 } }));
  fails(await api("POST", `${url}/open`, { token: admins.manager!.token }), 409, "RULE_VIOLATION");
  ok(await api("POST", `${url}/submit`, { token: admins.manager!.token }));
  fails(await api("POST", `${url}/approve`, { token: admins.manager!.token }), 409, "RULE_VIOLATION"); // drafter cannot approve
  ok(await api("POST", `${url}/approve`, { token: admins.manager2!.token }));
  fails(await api("POST", `${url}/approve`, { token: admins.finance!.token }), 409, "RULE_VIOLATION"); // no evidence yet
  fails(await api("PUT", `${url}/evidence`, { token: admins.manager!.token, body: { financialModelRef: "fm", rulesDocumentRef: "r", rulesText: "rules", escrowReference: "E", escrowFundedKobo: 100_000, auditorAdminId: admins.finance!.id } }), 400, "NOT_AN_AUDITOR");
  ok(await api("PUT", `${url}/evidence`, { token: admins.manager!.token, body: { financialModelRef: "fm", rulesDocumentRef: "r", rulesText: "rules", escrowReference: "E", escrowFundedKobo: 99_999, auditorAdminId: admins.auditor!.id } }));
  fails(await api("POST", `${url}/approve`, { token: admins.finance!.token }), 409, "RULE_VIOLATION"); // escrow ₦1 short
  ok(await api("PUT", `${url}/evidence`, { token: admins.manager!.token, body: { financialModelRef: "fm", rulesDocumentRef: "r", rulesText: "rules", escrowReference: "E", escrowFundedKobo: 100_000, auditorAdminId: admins.auditor!.id } }));
  assert.equal(ok(await api("POST", `${url}/approve`, { token: admins.finance!.token })).status, "APPROVED");
  // Locked from here on.
  fails(await api("POST", `${url}/prize-tiers`, { token: admins.manager!.token, body: { stage: "INSTANT", kind: "CASH", title: "late", cashKobo: 100_000, quantity: 1 } }), 409, "RULE_VIOLATION");
  fails(await api("PUT", `${url}/evidence`, { token: admins.manager!.token, body: { financialModelRef: "fm2", rulesDocumentRef: "r", rulesText: "new rules", escrowReference: "E", escrowFundedKobo: 0, auditorAdminId: admins.auditor!.id } }), 409, "RULE_VIOLATION");
  fails(await api("GET", `/v1/cycles/${c.id}`), 404, "NOT_FOUND"); // not public until committed
  const committed = ok(await api("POST", `${url}/commit`, { token: admins.manager!.token }));
  assert.equal(committed.tickets, 100);
  fails(await api("POST", `${url}/commit`, { token: admins.manager!.token }), 409, "NOT_APPROVED");
  const pub = ok(await api("GET", `/v1/cycles/${c.id}`));
  assert.equal(pub.commitment.ticket_merkle_root, committed.merkleRoot);
  assert.deepEqual(pub.instantWinOdds, { winners: 2, outOf: 100 });
  assert.equal(pub.mode, "SIMULATED");
  // Outcomes are not readable in the database before a card is revealed.
  const rows = (await pool.query("SELECT outcome_ciphertext, revealed_outcome FROM tickets WHERE cycle_id = $1", [c.id])).rows;
  assert.equal(rows.length, 100);
  for (const r of rows) {
    assert.equal(r.revealed_outcome, null);
    assert.ok(!r.outcome_ciphertext.toString("latin1").includes("CASH") && !r.outcome_ciphertext.toString("latin1").includes("NONE"));
  }
  // Even with direct database access, a real-money cycle cannot be opened without licence and certification.
  await assert.rejects(pool.query("UPDATE cycles SET mode = 'REAL_MONEY' WHERE id = $1", [c.id]), /locked/);
});

test("season economics: the prize budget is enforced at approval, and each player can buy at most 10 cards a day", async () => {
  const policy = config.policy!;
  config.policy = { ...POLICY }; // company defaults: 50% to prizes, 5% of that instant, 10 cards a day
  try {
    const now = Date.now(), mt = admins.manager!.token;
    const draft = async (name: string) => ok(await api("POST", "/v1/admin/cycles", { token: mt, body: { name, ticketPriceKobo: 50_000, totalTickets: 400, maxTicketsPerAccount: 50,
      salesOpenAt: new Date(now - 1000).toISOString(), salesCloseAt: new Date(now + 3600_000).toISOString(), drawAt: new Date(now + 3600_000).toISOString() } })).id as string;
    const tier = async (id: string, b: object) => ok(await api("POST", `/v1/admin/cycles/${id}/prize-tiers`, { token: mt, body: b }));
    const approveAll = async (id: string, escrow: number) => {
      ok(await api("PUT", `/v1/admin/cycles/${id}/evidence`, { token: mt, body: { financialModelRef: "fm", rulesDocumentRef: "r", rulesText: "rules", escrowReference: "E", escrowFundedKobo: escrow, auditorAdminId: admins.auditor!.id } }));
      ok(await api("POST", `/v1/admin/cycles/${id}/submit`, { token: mt }));
      ok(await api("POST", `/v1/admin/cycles/${id}/approve`, { token: admins.manager2!.token }));
      return api("POST", `/v1/admin/cycles/${id}/approve`, { token: admins.finance!.token });
    };
    // 400 cards at ₦500: ₦200,000 at sell-out, so ₦100,000 of prizes, of which ₦5,000 instant cash.
    const over = await draft("Over budget");
    await tier(over, { stage: "INSTANT", kind: "CASH", title: "₦500", cashKobo: 50_000, quantity: 11 });
    await tier(over, { stage: "FINAL_DRAW", kind: "CASH", title: "₦95,000", cashKobo: 9_500_000, quantity: 1, drawOrder: 1 });
    const b = ok(await api("GET", `/v1/admin/cycles/${over}`, { token: mt })).budget;
    assert.deepEqual([b.fullSalesKobo, b.poolKobo, b.instantBudgetKobo, b.drawBudgetKobo, b.instantKobo], [20_000_000, 10_000_000, 500_000, 9_500_000, 550_000]);
    // Instant cash is capped at its share; what it leaves unused is available to the final draw.
    const refused = await approveAll(over, 10_050_000);
    fails(refused, 409, "PRIZE_BUDGET");
    assert.match(refused.body.error.message, /Instant cash prizes total ₦5,500, above the ₦5,000 allowed \(5% of the ₦100,000 prize money\)/);
    const overDraw = await draft("Draw over budget");
    await tier(overDraw, { stage: "INSTANT", kind: "CASH", title: "₦500", cashKobo: 50_000, quantity: 4 });
    await tier(overDraw, { stage: "FINAL_DRAW", kind: "CASH", title: "₦98,001", cashKobo: 9_800_100, quantity: 1, drawOrder: 1 });
    const overAll = await approveAll(overDraw, 10_000_100);
    fails(overAll, 409, "PRIZE_BUDGET");
    assert.match(overAll.body.error.message, /Prizes total ₦100,001, above the ₦100,000 prize money \(50% of ₦200,000 full sell-out sales\)/);

    // Exactly on budget is approved.
    const fits = await draft("On budget");
    await tier(fits, { stage: "INSTANT", kind: "CASH", title: "₦500", cashKobo: 50_000, quantity: 10 });
    await tier(fits, { stage: "FINAL_DRAW", kind: "CASH", title: "₦95,000", cashKobo: 9_500_000, quantity: 1, drawOrder: 1 });
    assert.equal(ok(await approveAll(fits, 10_000_000)).status, "APPROVED");
    ok(await api("POST", `/v1/admin/cycles/${fits}/commit`, { token: mt }));
    ok(await api("POST", `/v1/admin/cycles/${fits}/open`, { token: mt }));
    const pub = ok(await api("GET", `/v1/cycles/${fits}`));
    assert.deepEqual([pub.max_tickets_per_day, pub.prize_share_bp, pub.instant_share_bp], [10, 5000, 500]);

    // At most 10 cards a day, however they are split.
    const p = await newPlayer();
    await buy(p, fits, 7);
    const left = await api("POST", "/v1/orders", { token: p.token, key: key(), body: { cycleId: fits, quantity: 5 } });
    fails(left, 403, "DAILY_CARD_LIMIT");
    assert.equal(left.body.error.message, "You can buy 3 more cards today (at most 10 a day).");
    await buy(p, fits, 3);
    const none = await api("POST", "/v1/orders", { token: p.token, key: key(), body: { cycleId: fits, quantity: 1 } });
    fails(none, 403, "DAILY_CARD_LIMIT");
    assert.match(none.body.error.message, /most cards allowed in one day \(10\)/);
    assert.equal(ok(await api("GET", `/v1/me/today?cycleId=${fits}`, { token: p.token })).cards, 10);
  } finally {
    config.policy = policy;
  }
});

test("buying: eligibility, limits, idempotency", async () => {
  cycleA = await openCycle({ total: 60, closeInMs: 9000, cap: 25, name: "Cycle A" });
  const unverified = await newPlayer({ verify: false });
  fails(await api("POST", "/v1/orders", { token: unverified.token, key: key(), body: { cycleId: cycleA.id, quantity: 1 } }), 403, "VERIFICATION_REQUIRED");
  const lagos = await newPlayer({ state: "NG-LA" });
  fails(await api("POST", "/v1/orders", { token: lagos.token, key: key(), body: { cycleId: cycleA.id, quantity: 1 } }), 403, "OUTSIDE_LICENSED_AREA");
  fails(await api("POST", "/v1/orders", { token: lagos.token, body: { cycleId: cycleA.id, quantity: 1 } }), 400, "INVALID_IDEMPOTENCY_KEY");
  fails(await api("POST", "/v1/orders", { token: lagos.token, key: key(), body: { cycleId: cycleA.id, quantity: 21 } }), 400, "INVALID_REQUEST");

  const p = await newPlayer();
  players.push(p);
  // Same request key twice = one order.
  const k = key();
  const o1 = ok(await api("POST", "/v1/orders", { token: p.token, key: k, body: { cycleId: cycleA.id, quantity: 2 } }));
  const o2 = ok(await api("POST", "/v1/orders", { token: p.token, key: k, body: { cycleId: cycleA.id, quantity: 2 } }));
  assert.equal(o1.orderId, o2.orderId);
  fails(await api("POST", "/v1/orders", { token: p.token, key: k, body: { cycleId: cycleA.id, quantity: 3 } }), 409, "IDEMPOTENCY_KEY_REUSED");
  // Nobody else can pay for (or learn about) this order.
  fails(await api("POST", "/v1/simulated-gateway/pay", { token: lagos.token, body: { paymentRef: o1.paymentRef } }), 404, "NOT_FOUND");
  // Paying twice, even at the same instant, issues the cards once.
  const [pay1, pay2] = await Promise.all([1, 2].map(() => api("POST", "/v1/simulated-gateway/pay", { token: p.token, body: { paymentRef: o1.paymentRef } })));
  assert.deepEqual(ok(pay1!).ticketIds.sort(), ok(pay2!).ticketIds.sort());
  assert.equal(ok(await api("GET", "/v1/tickets", { token: p.token })).tickets.length, 2);

  // Limits: daily ₦5,000 by default. 2 cards bought (₦400); 20 more (₦4,000) is fine, then 5 more (₦1,000) is over.
  await buy(p, cycleA.id, 18);
  fails(await api("POST", "/v1/orders", { token: p.token, key: key(), body: { cycleId: cycleA.id, quantity: 6 } }), 403, "SPENDING_LIMIT");
  // Two parallel orders that would each fit, but not together: only one gets through.
  const racing = await Promise.all([1, 2].map(() => api("POST", "/v1/orders", { token: p.token, key: key(), body: { cycleId: cycleA.id, quantity: 3 } })));
  assert.deepEqual(racing.map((r) => r.status).sort(), [200, 403]);
  // The unpaid order still counts towards the limit: ₦4,600 committed, so ₦600 more is refused.
  fails(await api("POST", "/v1/orders", { token: p.token, key: key(), body: { cycleId: cycleA.id, quantity: 3 } }), 403, "SPENDING_LIMIT");
  // Lowering a limit is immediate; raising waits 24 hours.
  const lim = ok(await api("PUT", "/v1/me/limits", { token: p.token, body: { dailyKobo: 400_000, weeklyKobo: 2_000_000, monthlyKobo: 5_000_000 } }));
  assert.equal(lim.dailyKobo, 400_000);
  const raised = ok(await api("PUT", "/v1/me/limits", { token: p.token, body: { dailyKobo: 1_000_000, weeklyKobo: 2_000_000, monthlyKobo: 5_000_000 } }));
  assert.equal(raised.dailyKobo, 400_000);
  assert.equal(raised.pending.dailyKobo, 1_000_000);
  fails(await api("PUT", "/v1/me/limits", { token: p.token, body: { dailyKobo: 3_000_000, weeklyKobo: 8_000_000, monthlyKobo: 20_000_000 } }), 400, "LIMIT_ABOVE_MAXIMUM");
});

test("exclusions: self-exclusion and the staff register block buying", async () => {
  const p = await newPlayer();
  ok(await api("POST", "/v1/me/exclusion", { token: p.token, body: { kind: "COOL_OFF", days: 7 } }));
  fails(await api("POST", "/v1/orders", { token: p.token, key: key(), body: { cycleId: cycleA.id, quantity: 1 } }), 403, "SELF_EXCLUDED");
  await assert.rejects(pool.query("DELETE FROM self_exclusions WHERE user_id = $1", [p.id]), /append-only/);

  const staffMember = await newPlayer();
  fails(await api("POST", "/v1/admin/exclusion-register", { token: admins.finance!.token, body: { category: "STAFF", phone: staffMember.phone } }), 403, "ROLE_REQUIRED");
  ok(await api("POST", "/v1/admin/exclusion-register", { token: admins.compliance!.token, body: { category: "STAFF", phone: staffMember.phone } }));
  fails(await api("POST", "/v1/orders", { token: staffMember.token, key: key(), body: { cycleId: cycleA.id, quantity: 1 } }), 403, "NOT_ELIGIBLE");
});

test("sell-out under load: no card sold twice, every payment gets its cards, cycle closes itself", async () => {
  // 20 cards are sold and 3 are held for an unpaid order. When its payment window passes, the hold is released.
  const { releaseExpiredHolds } = await import("../src/modules/tickets.ts");
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM tickets WHERE cycle_id = $1 AND status = 'RESERVED'", [cycleA.id])).rows[0].n, 3);
  await pool.query("UPDATE orders SET reserved_until = now() - interval '1 second' WHERE cycle_id = $1 AND status = 'PENDING'", [cycleA.id]);
  assert.equal(await releaseExpiredHolds(ctx), 3);
  // 40 remain. Four players race for 20 each: the cards are held when the order is placed, so two orders get
  // them and two are told at once that not enough are left — before anyone pays, so nobody needs a refund.
  const racers = await Promise.all([1, 2, 3, 4].map(() => newPlayer()));
  const orders = await Promise.all(racers.map((p) => api("POST", "/v1/orders", { token: p.token, key: key(), body: { cycleId: cycleA.id, quantity: 20 } })));
  assert.deepEqual(orders.map((r) => r.status).sort(), [200, 200, 409, 409]);
  for (const r of orders.filter((o) => o.status === 409)) assert.equal(r.body.error.code, "NOT_ENOUGH_CARDS");
  const paying = racers.map((p, i) => [p, orders[i]!] as const).filter(([, o]) => o.status === 200);
  const results = await Promise.all(paying.map(([p, o]) => api("POST", "/v1/simulated-gateway/pay", { token: p.token, body: { paymentRef: o.body.paymentRef } })));
  assert.deepEqual(results.map((r) => ok(r).status), ["FULFILLED", "FULFILLED"]);
  players.push(...paying.map(([p]) => p));

  const sold = (await pool.query("SELECT id, owner_id, order_id FROM tickets WHERE cycle_id = $1 AND status <> 'UNSOLD'", [cycleA.id])).rows;
  assert.equal(sold.length, 60);
  assert.equal(new Set(sold.map((t: any) => t.id)).size, 60);
  const perOrder = (await pool.query("SELECT o.quantity, count(t.id)::int AS n FROM orders o JOIN tickets t ON t.order_id = o.id WHERE o.cycle_id = $1 GROUP BY o.id", [cycleA.id])).rows;
  for (const r of perOrder) assert.equal(r.quantity, r.n);
  // Sold out before the closing date: the cycle is closed straight away.
  assert.equal(ok(await api("GET", `/v1/cycles/${cycleA.id}`)).status, "CLOSED");
  fails(await api("POST", "/v1/orders", { token: racers[0]!.token, key: key(), body: { cycleId: cycleA.id, quantity: 1 } }), 409, "SALES_CLOSED");
  // Revenue is exactly 60 cards, and no payment was refunded.
  const rev = (await pool.query("SELECT -balance_kobo AS b FROM ledger_balances WHERE code = $1", [`TICKET_REVENUE:${cycleA.id}`])).rows[0].b;
  assert.equal(rev, 60 * N200);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM refunds")).rows[0].n, 0);
});

test("scratch: every result verifies against the published fingerprint; reveal pays once", async () => {
  const root = Buffer.from(ok(await api("GET", `/v1/cycles/${cycleA.id}`)).commitment.ticket_merkle_root, "hex");
  let wins = 0, winTotal = 0;
  // The first player reveals everything; the others leave their cards unscratched for now.
  const p = players[0]!;
  const mine = ok(await api("GET", "/v1/tickets", { token: p.token, body: undefined })).tickets;
  assert.equal(mine.length, 20);
  assert.ok(mine.every((t: any) => t.result === undefined && t.enteredInFinalDraw));
  for (const t of mine) {
    const r = ok(await api("POST", `/v1/tickets/${t.id}/reveal`, { token: p.token }));
    const pr = r.proof;
    const steps = pr.steps.map((s: any) => ({ hash: Buffer.from(s.hash, "hex"), side: s.side }));
    const input = { cycleId: pr.cycleId, serial: pr.serial, outcome: pr.outcome, salt: Buffer.from(pr.salt, "hex") };
    assert.ok(verifyTicket(input, steps, root), "published root must match");
    // Claiming a different outcome for the same card does not verify.
    assert.ok(!verifyTicket({ ...input, outcome: pr.outcome === "NONE" ? "CASH:1000000" : "NONE" }, steps, root));
    if (r.ticket.result.cashKobo) { wins++; winTotal += r.ticket.result.cashKobo; assert.equal(r.ticket.result.acceptedAt, null); }
  }
  // Revealed prizes wait for the player to accept them; accepting all moves them into the wallet once.
  assert.equal(ok(await api("GET", "/v1/wallet", { token: p.token })).balanceKobo, 0);
  const [all1, all2] = await Promise.all([1, 2].map(() => api("POST", "/v1/tickets/accept-all", { token: p.token })));
  assert.equal(ok(all1!).acceptedKobo + ok(all2!).acceptedKobo, winTotal);
  assert.equal(ok(await api("GET", "/v1/wallet", { token: p.token })).balanceKobo, winTotal);
  // Reveal again, many times at once: same answer, nothing more is paid.
  const again = await Promise.all(mine.slice(0, 5).flatMap((t: any) => [1, 2, 3].map(() => api("POST", `/v1/tickets/${t.id}/reveal`, { token: p.token }))));
  for (const r of again) ok(r);
  assert.equal(ok(await api("GET", "/v1/wallet", { token: p.token })).balanceKobo, winTotal);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM prize_claims WHERE user_id = $1 AND stage = 'INSTANT'", [p.id])).rows[0].n, wins);
  // Someone else's card cannot be revealed or probed.
  fails(await api("POST", `/v1/tickets/${mine[0].id}/reveal`, { token: players[1]!.token }), 404, "NOT_FOUND");
  fails(await api("POST", `/v1/tickets/${randomUUID()}/reveal`, { token: p.token }), 404, "NOT_FOUND");
});

test("final draw: sign-offs, timing, reproducibility, runs once", async () => {
  const url = `/v1/admin/cycles/${cycleA.id}/draw`;
  fails(await api("POST", `${url}/execute`, { token: admins.auditor!.token }), 403, "ROLE_REQUIRED");
  fails(await api("POST", `${url}/sign`, { token: admins.auditor2!.token }), 403, "NOT_APPOINTED");
  fails(await api("POST", `${url}/sign`, { token: admins.approver!.token }), 403, "ROLE_REQUIRED");
  ok(await api("POST", `${url}/sign`, { token: admins.manager!.token }));
  ok(await api("POST", `${url}/sign`, { token: admins.manager!.token })); // signing twice still counts once
  if (Date.now() < cycleA.closeAt) fails(await api("POST", `${url}/execute`, { token: admins.manager!.token }), 409, "TOO_EARLY");
  await sleep(Math.max(0, cycleA.closeAt - Date.now()) + 2200); // published draw time, then the announced beacon round
  fails(await api("POST", `${url}/execute`, { token: admins.manager!.token }), 409, "SIGNOFF_MISSING"); // one operator only
  ok(await api("POST", `${url}/sign`, { token: admins.finance!.token }));
  fails(await api("POST", `${url}/execute`, { token: admins.manager!.token }), 409, "SIGNOFF_MISSING"); // auditor missing
  ok(await api("POST", `${url}/sign`, { token: admins.auditor!.token }));
  fails(await api("GET", `/v1/cycles/${cycleA.id}/draw`), 404, "NOT_FOUND");
  const done = ok(await api("POST", `${url}/execute`, { token: admins.manager!.token }));
  assert.deepEqual(done, { winners: 3, entries: 60 });
  fails(await api("POST", `${url}/execute`, { token: admins.manager!.token }), 409, "NOT_CLOSED");

  // A member of the public re-runs the draw from the published data alone.
  const d = ok(await api("GET", `/v1/cycles/${cycleA.id}/draw`));
  const secret = Buffer.from(d.secret, "hex");
  assert.ok(verifySecretCommitment(secret, Buffer.from(d.secret_commitment, "hex")), "secret is the one committed before sales");
  assert.equal(ok(await api("GET", `/v1/cycles/${cycleA.id}`)).commitment.draw_secret_commitment, d.secret_commitment);
  const eh = entriesHash(cycleA.id, d.entries);
  assert.equal(eh.toString("hex"), d.entries_sha256);
  const seed = deriveDrawSeed({ secret, beaconValue: Buffer.from(d.beacon_value, "hex"), cycleId: cycleA.id, entriesHash: eh });
  assert.equal(seed.toString("hex"), d.seed);
  const rerun = runDraw(d.entries, d.prizes.map((p: any) => ({ prizeId: p.prize_id, quantity: p.quantity })), seed);
  assert.deepEqual(rerun.map((w) => [w.prizeId, w.position, w.serial]), d.winners.map((w: any) => [w.prize_id, w.position, w.serial]));
  assert.equal(new Set(d.winners.map((w: any) => w.serial)).size, 3);

  // Cards nobody scratched were revealed automatically, and every instant prize was paid out exactly.
  const t = (await pool.query("SELECT count(*) FILTER (WHERE status = 'REVEALED')::int AS revealed, count(*) FILTER (WHERE revealed_outcome LIKE 'CASH:%')::int AS wins FROM tickets WHERE cycle_id = $1", [cycleA.id])).rows[0];
  assert.deepEqual(t, { revealed: 60, wins: 1 });
  const expense = (await pool.query("SELECT balance_kobo AS b FROM ledger_balances WHERE code = $1", [`PRIZE_EXPENSE:${cycleA.id}`])).rows[0].b;
  assert.equal(expense, 50_000 + 200_000);
  // Merchandise winners have an open claim with the 90-day window.
  const claims = (await pool.query("SELECT status, (expires_at - created_at) AS win FROM prize_claims WHERE stage = 'FINAL_DRAW' AND status = 'ENTITLED'")).rows;
  assert.equal(claims.length, 2);
  assert.equal(claims[0].win.days, 90);
  // The record cannot be altered afterwards.
  await assert.rejects(pool.query("UPDATE draw_winners SET position = 9 WHERE cycle_id = $1", [cycleA.id]), /append-only/);
});

test("closing date with unsold cards: the draw still runs, over sold cards only", async () => {
  const b = await openCycle({ total: 60, closeInMs: 2500, cap: 10, name: "Cycle B" });
  const p = await newPlayer();
  await buy(p, b.id, 5);
  // Per-cycle cap of 10 cards per account, even though the spending limit would allow more.
  fails(await api("POST", "/v1/orders", { token: p.token, key: key(), body: { cycleId: b.id, quantity: 6 } }), 403, "CYCLE_CAP");
  await sleep(Math.max(0, b.closeAt - Date.now()) + 2200);
  assert.deepEqual(await closeDueCycles(ctx), [b.id]);
  fails(await api("POST", "/v1/orders", { token: p.token, key: key(), body: { cycleId: b.id, quantity: 1 } }), 409, "SALES_CLOSED");
  for (const a of ["manager", "compliance", "auditor"]) ok(await api("POST", `/v1/admin/cycles/${b.id}/draw/sign`, { token: admins[a]!.token }));
  assert.deepEqual(ok(await api("POST", `/v1/admin/cycles/${b.id}/draw/execute`, { token: admins.compliance!.token })), { winners: 3, entries: 5 });
  const d = ok(await api("GET", `/v1/cycles/${b.id}/draw`));
  const mine = ok(await api("GET", `/v1/tickets?cycleId=${b.id}`, { token: p.token })).tickets.map((t: any) => t.serial);
  assert.deepEqual([...d.entries].sort(), [...mine].sort());
  assert.ok(d.winners.every((w: any) => mine.includes(w.serial)));
});

test("payouts: own verified bank account, PIN, second approver for large amounts", async () => {
  // The ₦2,000 draw winner.
  const winnerId = (await pool.query("SELECT user_id FROM prize_claims pc JOIN prize_tiers pt ON pt.id = pc.prize_tier_id WHERE pt.cycle_id = $1 AND pc.stage = 'FINAL_DRAW' AND pt.kind = 'CASH'", [cycleA.id])).rows[0].user_id;
  const w = players.find((p) => p.id === winnerId)!;
  const name = ok(await api("GET", "/v1/me", { token: w.token })).fullName;
  const start = ok(await api("GET", "/v1/wallet", { token: w.token })).balanceKobo;
  assert.ok(start >= 200_000);

  const wrongName = ok(await api("POST", "/v1/me/bank-accounts", { token: w.token, body: { bankCode: "058", accountNumber: "0123456789", accountName: "Somebody Else" } }));
  assert.equal(wrongName.nameMatch, false);
  const pay = (b: object, k = key()) => api("POST", "/v1/payouts", { token: w.token, key: k, body: b });
  fails(await pay({ amountKobo: 100_000, bankAccountId: wrongName.id, pin: w.pin }), 403, "NAME_MISMATCH");
  const acct = ok(await api("POST", "/v1/me/bank-accounts", { token: w.token, body: { bankCode: "058", accountNumber: "0123456780", accountName: name.split(" ").reverse().join("  ") } }));
  assert.equal(acct.nameMatch, true);
  fails(await pay({ amountKobo: 100_000, bankAccountId: acct.id, pin: "135790" }), 403, "PIN_REQUIRED");
  fails(await pay({ amountKobo: start + 1, bankAccountId: acct.id, pin: w.pin }), 409, "INSUFFICIENT_WINNINGS");
  // Another player cannot send money to (or from) this bank account.
  const other = players.find((p) => p.id !== w.id)!;
  fails(await api("POST", "/v1/payouts", { token: other.token, key: key(), body: { amountKobo: 50_000, bankAccountId: acct.id, pin: other.pin } }), 404, "NOT_FOUND");

  // Small payout goes straight through; the same request key never pays twice.
  const k = key();
  const small = ok(await pay({ amountKobo: 50_000, bankAccountId: acct.id, pin: w.pin }, k));
  assert.equal(small.status, "CONFIRMED");
  assert.equal(ok(await pay({ amountKobo: 50_000, bankAccountId: acct.id, pin: w.pin }, k)).id, small.id);
  assert.equal(ok(await api("GET", "/v1/wallet", { token: w.token })).balanceKobo, start - 50_000);

  // Two withdrawals of the whole balance at once: only one can succeed.
  const rest = start - 50_000;
  const both = await Promise.all([1, 2].map(() => pay({ amountKobo: rest, bankAccountId: acct.id, pin: w.pin })));
  assert.deepEqual(both.map((r) => r.status).sort(), [200, 409]);
  const held = both.find((r) => r.status === 200)!.body;
  assert.equal(held.status, "PENDING_APPROVAL"); // above the approval threshold
  assert.equal(ok(await api("GET", "/v1/wallet", { token: w.token })).balanceKobo, 0);

  const decide = (who: string, b: object) => api("POST", `/v1/admin/payouts/${held.id}/decision`, { token: admins[who]!.token, body: b });
  fails(await decide("finance", { approve: true }), 403, "ROLE_REQUIRED");
  fails(await decide("approver", { approve: false }), 400, "REASON_REQUIRED");
  assert.equal(ok(await decide("approver", { approve: false, reason: "Test rejection" })).status, "REJECTED");
  assert.equal(ok(await api("GET", "/v1/wallet", { token: w.token })).balanceKobo, rest); // money returned
  fails(await decide("approver", { approve: true }), 409, "ALREADY_DECIDED");

  const second = ok(await pay({ amountKobo: rest, bankAccountId: acct.id, pin: w.pin }));
  assert.equal(ok(await api("GET", "/v1/admin/payouts/pending", { token: admins.approver!.token })).payouts.length, 1);
  assert.equal(ok(await api("POST", `/v1/admin/payouts/${second.id}/decision`, { token: admins.approver!.token, body: { approve: true } })).status, "CONFIRMED");
  assert.equal(ok(await api("GET", "/v1/wallet", { token: w.token })).balanceKobo, 0);
  assert.equal((await pool.query("SELECT balance_kobo AS b FROM ledger_balances WHERE code = 'PAYOUTS_IN_TRANSIT'")).rows[0].b, 0);
});

test("books and records: ledger balances, dashboard agrees, audit trail intact", async () => {
  assert.equal((await pool.query("SELECT coalesce(sum(amount_kobo), 0)::bigint AS s FROM ledger_entries")).rows[0].s, 0);
  const unbalanced = (await pool.query("SELECT transaction_id FROM ledger_entries GROUP BY transaction_id HAVING sum(amount_kobo) <> 0")).rows;
  assert.equal(unbalanced.length, 0);

  fails(await api("GET", "/v1/admin/dashboard", { token: players[0]!.token }), 401, "UNAUTHENTICATED"); // a player token is not an admin token
  const dash = ok(await api("GET", "/v1/admin/dashboard", { token: admins.finance!.token }));
  assert.equal(dash.totals.ledger_balanced, true);
  const a = dash.cycles.find((c: any) => c.id === cycleA.id);
  assert.equal(a.sold, 60); assert.equal(a.remaining, 0);
  assert.equal(a.revenue_kobo, 60 * N200);
  assert.equal(a.outstanding_instant_liability_kobo, 0);
  assert.equal(a.merchandise_outstanding, 2);
  // Cash in the clearing account = everything collected minus everything paid out.
  const paidOut = (await pool.query("SELECT coalesce(sum(amount_kobo), 0)::bigint AS s FROM payouts WHERE status = 'CONFIRMED'")).rows[0].s;
  const collected = (await pool.query("SELECT coalesce(sum(amount_kobo), 0)::bigint AS s FROM orders WHERE status = 'FULFILLED'")).rows[0].s;
  assert.equal(dash.totals.gateway_clearing_kobo, collected - paidOut);

  fails(await api("GET", "/v1/admin/audit", { token: admins.manager!.token }), 403, "ROLE_REQUIRED");
  const trail = ok(await api("GET", "/v1/admin/audit", { token: admins.auditor!.token }));
  assert.equal(trail.chainIntact, true);
  // Tampering by someone with direct database access is detected.
  await pool.query("ALTER TABLE audit_log DISABLE TRIGGER audit_log_append_only");
  await pool.query("UPDATE audit_log SET details = '{\"edited\":true}' WHERE seq = 5");
  await pool.query("ALTER TABLE audit_log ENABLE TRIGGER audit_log_append_only");
  const tampered = ok(await api("GET", "/v1/admin/audit", { token: admins.auditor!.token }));
  assert.equal(tampered.chainIntact, false);
  assert.equal(tampered.firstBrokenSeq, 5);
  const actions = (await pool.query("SELECT DISTINCT action FROM audit_log")).rows.map((r: any) => r.action);
  for (const expected of ["player.registered", "kyc.verified", "cycle.approved", "cycle.committed", "order.fulfilled", "ticket.revealed", "cycle.closed", "draw.executed", "payout.requested", "payout.approved", "payout.rejected"]) {
    assert.ok(actions.includes(expected), `audit log should contain ${expected}`);
  }
  // No secrets in the audit trail.
  const dump = JSON.stringify((await pool.query("SELECT details FROM audit_log")).rows);
  assert.ok(!/482915|devCode|pin_hash/.test(dump));
});

test("the simulation refuses to start unless switched on, and refuses to be reachable from other machines", () => {
  assert.throws(() => assertSimulationAcknowledged({}, "127.0.0.1"), /Set WR_SIMULATION=1/);
  assert.doesNotThrow(() => assertSimulationAcknowledged({ WR_SIMULATION: "1" }, "127.0.0.1"));
  assert.throws(() => assertSimulationAcknowledged({ WR_SIMULATION: "1" }, "0.0.0.0"), /could sign in as any administrator/);
  assert.doesNotThrow(() => assertSimulationAcknowledged({ WR_SIMULATION: "1", WR_ALLOW_PUBLIC_SIMULATION: "1" }, "0.0.0.0"));
});

test("rate limiting applies to sign-in endpoints", async () => {
  const limited = buildServer({ ...ctx, config: { ...config, rateLimits: { auth: 5, general: 1000 } } });
  const codes: number[] = [];
  for (let i = 0; i < 7; i++) codes.push((await api("POST", "/v1/auth/login", { body: { phone: "08031112222", pin: "482915" } }, limited)).status);
  assert.deepEqual(codes, [401, 401, 401, 401, 401, 429, 429]);
  await limited.close();
});

test("web sessions: cookie is script-proof, cross-site requests are refused, only web-app files are served", async () => {
  const web = buildServer({ ...ctx, config: { ...config, webRoot: new URL("../../web/public", import.meta.url).pathname } });
  const phone = "08037770001";
  const otp = ok(await api("POST", "/v1/auth/otp", { body: { phone } }, web));
  const reg = await web.inject({ method: "POST", url: "/v1/auth/register", payload: { phone, code: otp.devCode, pin: "482915", acceptPrivacy: true } });
  const setCookie = String(reg.headers["set-cookie"]);
  assert.match(setCookie, /^wr_session=[\w-]+; Path=\/; HttpOnly; SameSite=Strict; Secure; Max-Age=\d+$/);
  const cookie = setCookie.split(";")[0]!;

  // Reading with the cookie works; changing anything also needs the custom header a foreign site cannot send.
  assert.equal((await web.inject({ method: "GET", url: "/v1/me", headers: { cookie } })).statusCode, 200);
  const change = { method: "PUT" as const, url: "/v1/me/limits", payload: { dailyKobo: 100_000, weeklyKobo: 400_000, monthlyKobo: 1_000_000 } };
  const refused = await web.inject({ ...change, headers: { cookie } });
  assert.equal(refused.statusCode, 403);
  assert.equal(JSON.parse(refused.body).error.code, "CSRF");
  assert.equal((await web.inject({ ...change, headers: { cookie, "x-wr-client": "web" } })).statusCode, 200);

  // Signing out ends the session on the server, not just in the browser.
  const out = await web.inject({ method: "POST", url: "/v1/auth/logout", headers: { cookie, "x-wr-client": "web" }, payload: {} });
  assert.match(String(out.headers["set-cookie"]), /Max-Age=0/);
  assert.equal((await web.inject({ method: "GET", url: "/v1/me", headers: { cookie } })).statusCode, 401);

  // Static files: the app shell with strict headers, and nothing outside the web folder.
  const page = await web.inject({ method: "GET", url: "/" });
  assert.equal(page.statusCode, 200);
  assert.match(String(page.headers["content-security-policy"]), /default-src 'self'/);
  assert.ok(!/unsafe-inline|unsafe-eval/.test(String(page.headers["content-security-policy"])));
  assert.equal(page.headers["x-frame-options"], "DENY");
  assert.ok(!/<script(?![^>]*\bsrc=)|\son\w+=|style=/.test(page.body), "no inline script, handlers or styles");
  assert.equal((await web.inject({ method: "GET", url: "/js/app.js" })).statusCode, 200);
  for (const url of ["/../package.json", "/..%2f..%2fpackage.json", "/js/../../src/main.ts", "/.env"]) {
    assert.equal((await web.inject({ method: "GET", url })).statusCode, 404, url);
  }
  await web.close();
});

test("admin web app: separate cookie session, role-limited views, no outcomes exposed", async () => {
  const web = buildServer({ ...ctx, config: { ...config, webRoot: new URL("../../web/public", import.meta.url).pathname, adminRoot: new URL("../../admin/public", import.meta.url).pathname } });
  const signIn = async (name: string) => {
    const r = await web.inject({ method: "POST", url: "/v1/admin/dev-login", payload: { email: `${name}@example.test` } });
    const c = String(r.headers["set-cookie"]);
    assert.match(c, /^wr_admin=[\w-]+; Path=\/; HttpOnly; SameSite=Strict; Secure; Max-Age=28800$/);
    return c.split(";")[0]!;
  };
  const cookie = await signIn("finance");
  const getAs = async (c: string, url: string) => { const r = await web.inject({ method: "GET", url, headers: { cookie: c } }); return { status: r.statusCode, body: JSON.parse(r.body) }; };
  assert.deepEqual((await getAs(cookie, "/v1/admin/me")).body.roles, ["FINANCE"]);
  // An admin cookie is not a player session, and changing anything needs the custom header.
  assert.equal((await getAs(cookie, "/v1/me")).status, 401);
  assert.equal((await web.inject({ method: "POST", url: `/v1/admin/cycles/${cycleA.id}/approve`, headers: { cookie }, payload: {} })).statusCode, 403);

  const detail = (await getAs(cookie, `/v1/admin/cycles/${cycleA.id}`)).body;
  assert.equal(detail.status, "DRAWN");
  assert.equal(detail.counts.sold, 60);
  assert.equal(detail.approvals.length, 2);
  assert.equal(detail.signoffs.length, 3);
  assert.equal(detail.cashCoverRequiredKobo, 250_000);
  assert.deepEqual([detail.budget.poolKobo, detail.budget.instantBudgetKobo, detail.budget.instantKobo, detail.budget.drawKobo], [600_000, 60_000, 50_000, 300_000]);
  assert.equal(detail.editable, false);
  // Nothing an administrator can fetch contains ticket outcomes, salts or secrets.
  const everything = JSON.stringify([detail, (await getAs(cookie, "/v1/admin/cycles")).body, (await getAs(cookie, "/v1/admin/dashboard")).body]);
  assert.ok(!/outcome|salt|ciphertext|wrapped|"secret"/i.test(everything));

  assert.equal((await getAs(cookie, "/v1/admin/audit")).status, 403); // finance cannot read the audit trail
  const comp = (await getAs(cookie, "/v1/admin/compliance")).body;
  assert.deepEqual(comp.realMoneyGate, { licences: 0, certifications: 0 });
  assert.ok(comp.register.every((r: any) => r.phone === null || /^…\d{4}$/.test(r.phone)), "phones are masked");

  // Friendly refusals instead of database text.
  const mgr = await signIn("manager");
  const post = async (c: string, url: string, payload: object) => { const r = await web.inject({ method: "POST", url, headers: { cookie: c, "x-wr-client": "web" }, payload }); return { status: r.statusCode, body: JSON.parse(r.body) }; };
  const now = Date.now();
  const draft = (await post(mgr, "/v1/admin/cycles", { name: "Msg", ticketPriceKobo: N200, totalTickets: 10, maxTicketsPerAccount: 5, salesOpenAt: new Date(now).toISOString(), salesCloseAt: new Date(now + 3600_000).toISOString(), drawAt: new Date(now + 3600_000).toISOString() })).body;
  const big = await post(mgr, `/v1/admin/cycles/${draft.id}/prize-tiers`, { stage: "INSTANT", kind: "CASH", title: "big", cashKobo: 5_000_000, quantity: 1 });
  assert.equal(big.status, 400);
  assert.match(big.body.error.message, /between ₦500 and ₦10,000/);

  // The admin app is served under /admin, with the same strict headers.
  const page = await web.inject({ method: "GET", url: "/admin" });
  assert.equal(page.statusCode, 200);
  assert.match(page.body, /Rewards Admin/);
  assert.ok(!/<script(?![^>]*\bsrc=)|\son\w+=|style=/.test(page.body));
  assert.equal((await web.inject({ method: "GET", url: "/admin/js/app.js" })).statusCode, 200);
  const out = await web.inject({ method: "POST", url: "/v1/admin/logout", headers: { cookie, "x-wr-client": "web" }, payload: {} });
  assert.match(String(out.headers["set-cookie"]), /Max-Age=0/);
  assert.equal((await getAs(cookie, "/v1/admin/me")).status, 401);
  await web.close();
});

test("merchandise: stock must exist before approval, cannot be diverted, and is handed over only against the winner's code", async () => {
  const ft = admins.fulfilment!.token, mt = admins.manager!.token;
  const { expireClaims } = await import("../src/modules/inventory.ts");

  // --- A cycle cannot be approved on a promise: the goods must be in the warehouse and reserved. ---
  const now = Date.now();
  const c = ok(await api("POST", "/v1/admin/cycles", { token: mt, body: { name: "Stock check", ticketPriceKobo: N200, totalTickets: 20, maxTicketsPerAccount: 5, salesOpenAt: new Date(now).toISOString(), salesCloseAt: new Date(now + 3600_000).toISOString(), drawAt: new Date(now + 3600_000).toISOString() } }));
  ok(await api("POST", `/v1/admin/cycles/${c.id}/prize-tiers`, { token: mt, body: { stage: "FINAL_DRAW", kind: "MERCHANDISE", title: "Solar freezer", skuId, quantity: 2, drawOrder: 1 } }));
  ok(await api("PUT", `/v1/admin/cycles/${c.id}/evidence`, { token: mt, body: { financialModelRef: "fm", rulesDocumentRef: "r", rulesText: "rules", escrowReference: "E", escrowFundedKobo: 0, auditorAdminId: admins.auditor!.id } }));
  fails(await api("POST", `/v1/admin/cycles/${c.id}/reserve-stock`, { token: mt }), 403, "ROLE_REQUIRED"); // the drafter cannot vouch for stock
  const partial = ok(await api("POST", `/v1/admin/cycles/${c.id}/reserve-stock`, { token: ft }));
  assert.equal(partial.complete, false); // 5 received, 4 already committed to earlier cycles
  assert.deepEqual(partial.cover.map((x: any) => [x.needed, x.reserved]), [[2, 1]]);
  ok(await api("POST", `/v1/admin/cycles/${c.id}/submit`, { token: mt }));
  ok(await api("POST", `/v1/admin/cycles/${c.id}/approve`, { token: admins.manager2!.token }));
  const refused = await api("POST", `/v1/admin/cycles/${c.id}/approve`, { token: admins.finance!.token });
  fails(refused, 409, "RULE_VIOLATION");
  assert.match(refused.body.error.message, /in stock and reserved.*needs 2, 1 reserved/);
  fails(await api("POST", "/v1/admin/stock/receive", { token: ft, body: { skuId, supplierId, warehouseId, poReference: "PO-2", quantity: 1, acquisitionCostKobo: 1, landedCostKobo: 1 } }), 400, "SERIALS_REQUIRED");
  fails(await api("POST", "/v1/admin/stock/receive", { token: ft, body: { skuId, supplierId, warehouseId, poReference: "PO-2", serialNumbers: ["SN-1"], acquisitionCostKobo: 1, landedCostKobo: 1 } }), 409, "ALREADY_EXISTS");
  fails(await api("POST", "/v1/admin/stock/receive", { token: ft, body: { skuId, supplierId, warehouseId, poReference: "PO-2", serialNumbers: ["SN-6"], acquisitionCostKobo: 5, landedCostKobo: 4 } }), 400, "INVALID_COST");
  ok(await api("POST", "/v1/admin/stock/receive", { token: ft, body: { skuId, supplierId, warehouseId, poReference: "PO-2", serialNumbers: ["SN-6"], acquisitionCostKobo: 30_000, landedCostKobo: 40_000 } }));
  assert.equal(ok(await api("POST", `/v1/admin/cycles/${c.id}/reserve-stock`, { token: ft })).complete, true);
  assert.equal(ok(await api("POST", `/v1/admin/cycles/${c.id}/approve`, { token: admins.finance!.token })).status, "APPROVED");
  fails(await api("POST", `/v1/admin/cycles/${c.id}/reserve-stock`, { token: ft }), 409, "CYCLE_LOCKED");

  // --- Even with direct database access, committed prizes cannot be released, re-costed or deleted. ---
  await assert.rejects(pool.query("UPDATE stock_units SET status = 'IN_STOCK', reserved_cycle_id = NULL WHERE reserved_cycle_id = $1", [cycleA.id]), /committed as a prize in a live cycle/);
  await assert.rejects(pool.query("UPDATE stock_units SET reserved_cycle_id = $2 WHERE reserved_cycle_id = $1", [cycleA.id, c.id]), /committed as a prize/);
  await assert.rejects(pool.query("UPDATE stock_units SET landed_cost_kobo = 1 WHERE serial_number = 'SN-1'"), /cannot be changed/);
  await assert.rejects(pool.query("DELETE FROM stock_units WHERE serial_number = 'SN-1'"), /append-only/);
  await assert.rejects(pool.query("UPDATE stock_units SET status = 'DELIVERED' WHERE reserved_cycle_id = $1", [cycleA.id]), /cannot move from RESERVED to DELIVERED/);

  // --- The winner claims. ---
  const open = (await pool.query(
    `SELECT pc.id, pc.user_id FROM prize_claims pc JOIN prize_tiers pt ON pt.id = pc.prize_tier_id WHERE pt.cycle_id = $1 AND pt.kind = 'MERCHANDISE' ORDER BY pc.created_at, pc.id`, [cycleA.id])).rows;
  assert.equal(open.length, 2);
  const playerOf = (id: string) => players.find((p) => p.id === id)!;
  const setKin = async (p: Player) => {
    if (!ok(await api("GET", "/v1/me", { token: p.token })).nextOfKin) ok(await api("PUT", "/v1/me/next-of-kin", { token: p.token, body: { fullName: "Next Kin", relationship: "Sister", phone: "08030000099" } }));
  };
  const w1 = playerOf(open[0].user_id), claim1 = open[0].id;
  const mine = ok(await api("GET", "/v1/claims", { token: w1.token })).claims;
  assert.ok(mine.some((x: any) => x.id === claim1 && x.status === "ENTITLED" && x.handoverCode === null));
  const redeem = (p: Player, id: string, b: object) => api("POST", `/v1/claims/${id}/redeem`, { token: p.token, body: b });
  const hadKin = ok(await api("GET", "/v1/me", { token: w1.token })).nextOfKin;
  if (!hadKin) fails(await redeem(w1, claim1, { method: "COLLECTION", stockistId: await centre(), pin: w1.pin }), 403, "NEXT_OF_KIN_REQUIRED");
  await setKin(w1); // adding a next of kin for the first time is allowed even with a prize waiting
  fails(await redeem(w1, claim1, { method: "COLLECTION", stockistId: await centre(), pin: "135790" }), 403, "PIN_REQUIRED");
  fails(await redeem(w1, claim1, { method: "COLLECTION", pin: w1.pin }), 400, "CENTRE_REQUIRED");
  fails(await redeem(w1, claim1, { method: "DELIVERY", pin: w1.pin }), 400, "ADDRESS_REQUIRED");
  const stranger = players.find((p) => p.id !== w1.id && p.id !== open[1].user_id) ?? await newPlayer();
  fails(await redeem(stranger, claim1, { method: "COLLECTION", stockistId: await centre(), pin: stranger.pin }), 404, "NOT_FOUND");
  assert.equal(ok(await redeem(w1, claim1, { method: "DELIVERY", address: "12 Bosso Road, Minna", pin: w1.pin })).status, "VERIFIED");
  fails(await redeem(w1, claim1, { method: "COLLECTION", stockistId: await centre(), pin: w1.pin }), 409, "ALREADY_CLAIMED");
  // With a claim in progress, the next of kin can no longer be swapped.
  fails(await api("PUT", "/v1/me/next-of-kin", { token: w1.token, body: { fullName: "Someone Else", relationship: "Friend", phone: "08030000098" } }), 409, "CLAIM_IN_PROGRESS");

  // --- Fulfilment dispatches; only the winner ever sees the handover code. ---
  const queue = ok(await api("GET", "/v1/admin/fulfilment", { token: ft })).claims;
  const q1 = queue.find((x: any) => x.id === claim1);
  assert.equal(q1.status, "VERIFIED"); assert.equal(q1.address, "12 Bosso Road, Minna"); assert.match(q1.serial_number, /^SN-\d$/);
  assert.ok(!/handover_otp|handoverCode/.test(JSON.stringify(queue)));
  fails(await api("POST", `/v1/admin/fulfilment/${claim1}/dispatch`, { token: admins.finance!.token, body: { carrier: "X" } }), 403, "ROLE_REQUIRED");
  fails(await api("POST", `/v1/admin/fulfilment/${claim1}/dispatch`, { token: ft, body: {} }), 400, "CARRIER_REQUIRED");
  fails(await api("POST", `/v1/admin/fulfilment/${claim1}/handover`, { token: ft, body: { code: "000000", photoRef: "p.jpg" } }), 409, "NOT_IN_TRANSIT");
  ok(await api("POST", `/v1/admin/fulfilment/${claim1}/dispatch`, { token: ft, body: { carrier: "Test Logistics", trackingRef: "TL-1" } }));
  fails(await api("POST", `/v1/admin/fulfilment/${claim1}/dispatch`, { token: ft, body: { carrier: "Again" } }), 409, "NOT_READY");
  const code = ok(await api("GET", "/v1/claims", { token: w1.token })).claims.find((x: any) => x.id === claim1).handoverCode;
  assert.match(code, /^\d{6}$/);
  const stored = (await pool.query("SELECT handover_otp_hash, handover_otp_enc FROM shipments WHERE prize_claim_id = $1", [claim1])).rows[0];
  assert.ok(!stored.handover_otp_hash.includes(code) && !stored.handover_otp_enc.toString("latin1").includes(code), "code is not stored in readable form");
  const wrong = code === "000000" ? "000001" : "000000";
  fails(await api("POST", `/v1/admin/fulfilment/${claim1}/handover`, { token: ft, body: { code: wrong, photoRef: "p.jpg" } }), 403, "WRONG_CODE");
  fails(await api("POST", `/v1/admin/fulfilment/${claim1}/handover`, { token: ft, body: { code } }), 400, "PHOTO_REQUIRED"); // a photo is mandatory
  assert.equal(ok(await api("POST", `/v1/admin/fulfilment/${claim1}/handover`, { token: ft, body: { code, photoRef: "handover/claim1.jpg", warrantyDocumentRef: "warranty/SN.pdf" } })).status, "DELIVERED");
  fails(await api("POST", `/v1/admin/fulfilment/${claim1}/handover`, { token: ft, body: { code, photoRef: "p.jpg" } }), 409, "NOT_IN_TRANSIT");
  const delivered = ok(await api("GET", "/v1/claims", { token: w1.token })).claims.find((x: any) => x.id === claim1);
  assert.equal(delivered.status, "DELIVERED"); assert.equal(delivered.handoverCode, null); assert.equal(delivered.warranty_months, 24); assert.ok(delivered.serial_number);
  assert.equal((await pool.query("SELECT u.status FROM stock_units u JOIN prize_claims pc ON pc.stock_unit_id = u.id WHERE pc.id = $1", [claim1])).rows[0].status, "DELIVERED");

  // --- Guessing the code locks the handover. ---
  const w2 = playerOf(open[1].user_id), claim2 = open[1].id;
  await setKin(w2);
  ok(await redeem(w2, claim2, { method: "COLLECTION", stockistId: await centre(), pin: w2.pin }));
  ok(await api("POST", `/v1/admin/fulfilment/${claim2}/dispatch`, { token: ft, body: {} })); // collection needs no carrier
  const code2 = ok(await api("GET", "/v1/claims", { token: w2.token })).claims.find((x: any) => x.id === claim2).handoverCode;
  const bad = code2 === "111111" ? "111112" : "111111";
  fails(await api("POST", `/v1/admin/fulfilment/${claim2}/handover`, { token: ft, body: { code: bad, photoRef: "p.jpg" } }), 400, "ID_CHECK_REQUIRED"); // collected at a centre
  for (let i = 0; i < 5; i++) fails(await api("POST", `/v1/admin/fulfilment/${claim2}/handover`, { token: ft, body: { code: bad, photoRef: "p.jpg", idChecked: "NIN_SLIP" } }), 403, "WRONG_CODE");
  fails(await api("POST", `/v1/admin/fulfilment/${claim2}/handover`, { token: ft, body: { code: code2, photoRef: "p.jpg", idChecked: "NIN_SLIP" } }), 429, "HANDOVER_LOCKED");
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM compliance_alerts WHERE kind = 'HANDOVER_CODE_FAILURES' AND entity_id = $1", [claim2])).rows[0].n, 1);

  // --- Records: costs, serial numbers, where every unit is. ---
  const inv = ok(await api("GET", "/v1/admin/inventory", { token: admins.auditor!.token }));
  const item = inv.items.find((i: any) => i.id === skuId);
  assert.deepEqual([item.in_stock, item.reserved, item.with_winners, item.delivered], [0, 4, 1, 1]);
  assert.equal(item.avg_landed_cost_kobo, 40_000);
  assert.equal(item.stock_value_kobo, 5 * 40_000);
  assert.ok(inv.units.every((u: any) => u.serial_number && u.supplier === "Test Supplier" && u.warehouse === "Minna"));
  fails(await api("GET", "/v1/admin/inventory", { token: admins.approver!.token }), 403, "ROLE_REQUIRED");

  // --- Unclaimed prizes close when the published window ends. ---
  const late = (await pool.query("SELECT pc.id, pc.user_id FROM prize_claims pc WHERE pc.status = 'ENTITLED' LIMIT 1")).rows[0];
  await pool.query("UPDATE prize_claims SET expires_at = now() - interval '1 minute' WHERE id = $1", [late.id]);
  assert.equal(await expireClaims(ctx), 1);
  assert.equal((await pool.query("SELECT status FROM prize_claims WHERE id = $1", [late.id])).rows[0].status, "EXPIRED");
});

test("refunds and cancelled cycles: two people, original payment only, prizes forfeited or honoured as the rules say", async () => {
  const ft = admins.fulfilment!.token, ct = admins.compliance!.token, fin = admins.finance!.token, mt = admins.manager!.token;
  // Two cheap prizes in stock so the new cycle's merchandise can be secured.
  const keyRing = ok(await api("POST", "/v1/admin/skus", { token: ft, body: { name: "Key ring", advertisedValueKobo: 10_000, serialised: true } })).id;
  ok(await api("POST", "/v1/admin/stock/receive", { token: ft, body: { skuId: keyRing, supplierId, warehouseId, poReference: "PO-3", serialNumbers: ["SN-7", "SN-8"], acquisitionCostKobo: 5_000, landedCostKobo: 6_000 } }));
  // To check the prize rules, almost every card must win: 10 of 11. Only possible with a far higher
  // instant-win share than company policy, so this one cycle is drafted under an overridden policy.
  const policy = config.policy!;
  config.policy = { ...POLICY, prizeShareBp: 10_000, instantShareBp: 9_100 };
  const v = await openCycle({ total: 11, closeInMs: 3600_000, cap: 11, name: "Void check", priceKobo: 50_000, escrowKobo: 500_000, tiers: [
    { stage: "INSTANT", kind: "CASH", title: "₦500", cashKobo: 50_000, quantity: 10 },
    { stage: "FINAL_DRAW", kind: "MERCHANDISE", title: "Key ring", skuId: keyRing, quantity: 2, drawOrder: 1 }] });
  config.policy = policy;
  const [p1, p2, p3, p4] = [await newPlayer(), await newPlayer(), await newPlayer(), await newPlayer()];
  await buy(p1, v.id, 4); await buy(p2, v.id, 3); await buy(p3, v.id, 2);
  const cards = async (p: Player) => ok(await api("GET", `/v1/tickets?cycleId=${v.id}`, { token: p.token })).tickets;
  const reveal = async (p: Player, id: string) => ok(await api("POST", `/v1/tickets/${id}/reveal`, { token: p.token })).ticket.result.cashKobo as number;
  /** Scratches a player's cards until `wins` of them have won (only one card in the cycle loses). */
  const scratchUntil = async (p: Player, list: any[], wins: number) => {
    let total = 0, found = 0, i = 0;
    while (found < wins) { const c = await reveal(p, list[i++].id); if (c) { total += c; found++; } }
    return { total, next: list[i] };
  };
  const p1Cards = await cards(p1);
  const { total: w1, next: p1Unscratched } = await scratchUntil(p1, p1Cards, 2);
  const p3Cards = await cards(p3);
  const { total: w3 } = await scratchUntil(p3, p3Cards, 1);
  // p3 accepts the prize into the wallet; p1 leaves both prizes waiting to be accepted.
  ok(await api("POST", "/v1/tickets/accept-all", { token: p3.token }));
  assert.equal(ok(await api("GET", "/v1/wallet", { token: p1.token })).balanceKobo, 0);
  const wallet = async (p: Player) => ok(await api("GET", "/v1/wallet", { token: p.token }));
  const orderOf = async (p: Player) => (await pool.query("SELECT id FROM orders WHERE user_id = $1 AND cycle_id = $2 AND status = 'FULFILLED'", [p.id, v.id])).rows[0].id as string;
  const revenue = async () => 0 - (await pool.query("SELECT coalesce(sum(e.amount_kobo),0)::bigint AS b FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id WHERE a.code = $1", [`TICKET_REVENUE:${v.id}`])).rows[0].b;
  assert.equal(await revenue(), 9 * 50_000);

  // p3 withdraws the prize before anyone notices the purchase was not allowed.
  const name3 = ok(await api("GET", "/v1/me", { token: p3.token })).fullName;
  const acct3 = ok(await api("POST", "/v1/me/bank-accounts", { token: p3.token, body: { bankCode: "058", accountNumber: "0987654321", accountName: name3 } }));
  ok(await api("POST", "/v1/payouts", { token: p3.token, key: key(), body: { amountKobo: w3, bankAccountId: acct3.id, pin: p3.pin } }));
  assert.equal((await wallet(p3)).balanceKobo, 0);

  // --- Manual refund: Compliance asks, Finance decides. ---
  const order3 = await orderOf(p3);
  const search = ok(await api("GET", `/v1/admin/orders?phone=${p3.phone}`, { token: ct })).orders;
  assert.equal(search.length, 1); assert.equal(search[0].id, order3); assert.match(search[0].player_phone, /^…\d{4}$/);
  fails(await api("GET", "/v1/admin/orders", { token: ct }), 400, "SEARCH_REQUIRED");
  fails(await api("POST", `/v1/admin/orders/${order3}/refund`, { token: fin, body: { reason: "INELIGIBLE_PURCHASE", note: "x" } }), 403, "ROLE_REQUIRED");
  const rq3 = ok(await api("POST", `/v1/admin/orders/${order3}/refund`, { token: ct, body: { reason: "INELIGIBLE_PURCHASE", note: "Buyer is a staff relative" } }));
  assert.equal(rq3.status, "AWAITING_APPROVAL");
  fails(await api("POST", `/v1/admin/orders/${order3}/refund`, { token: ct, body: { reason: "INELIGIBLE_PURCHASE", note: "again" } }), 409, "ALREADY_REFUNDED");
  fails(await api("POST", `/v1/admin/refunds/${rq3.id}/decision`, { token: ct, body: { approve: true } }), 403, "ROLE_REQUIRED");
  // Nothing has happened yet: cards still valid, money not moved.
  assert.equal((await cards(p3)).filter((t: any) => t.status !== "CANCELLED").length, 2);
  // Even directly in the database, the requester cannot approve their own refund.
  await assert.rejects(pool.query("UPDATE refunds SET status = 'CONFIRMED', approved_by = requested_by WHERE id = $1", [rq3.id]), /refunds_check/);
  assert.equal(ok(await api("GET", "/v1/admin/refunds?status=AWAITING_APPROVAL", { token: fin })).refunds.length, 1);
  assert.equal(ok(await api("POST", `/v1/admin/refunds/${rq3.id}/decision`, { token: fin, body: { approve: true } })).status, "CONFIRMED");
  fails(await api("POST", `/v1/admin/refunds/${rq3.id}/decision`, { token: fin, body: { approve: true } }), 409, "ALREADY_DECIDED");
  // Cards cancelled, prize forfeited, and because it was already withdrawn the player now owes it.
  assert.ok((await cards(p3)).every((t: any) => t.status === "CANCELLED" && !t.enteredInFinalDraw));
  fails(await api("POST", `/v1/tickets/${p3Cards[1].id}/reveal`, { token: p3.token }), 409, "CARD_CANCELLED");
  const w = await wallet(p3);
  assert.equal(w.balanceKobo, 0); assert.equal(w.owedKobo, w3);
  fails(await api("POST", "/v1/payouts", { token: p3.token, key: key(), body: { amountKobo: 50_000, bankAccountId: acct3.id, pin: p3.pin } }), 409, "INSUFFICIENT_WINNINGS");
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM compliance_alerts WHERE kind = 'PRIZE_RECOVERY_REQUIRED' AND entity_id = $1", [p3.id])).rows[0].n, 1);
  const mine3 = ok(await api("GET", "/v1/orders", { token: p3.token })).orders;
  assert.equal(mine3[0].status, "REFUNDED"); assert.equal(mine3[0].refund_reason, "INELIGIBLE_PURCHASE");
  assert.equal(await revenue(), 7 * 50_000);
  // Refunds are permanent records.
  await assert.rejects(pool.query("DELETE FROM refunds WHERE id = $1", [rq3.id]), /append-only/);
  await assert.rejects(pool.query("UPDATE refunds SET amount_kobo = 1 WHERE id = $1", [rq3.id]), /cannot be changed/);

  // A rejected request leaves everything as it was, and can be raised again.
  const order2 = await orderOf(p2);
  const rq2 = ok(await api("POST", `/v1/admin/orders/${order2}/refund`, { token: ct, body: { reason: "DISPUTED_PAYMENT", note: "Card holder disputes" } }));
  fails(await api("POST", `/v1/admin/refunds/${rq2.id}/decision`, { token: fin, body: { approve: false } }), 400, "REASON_REQUIRED");
  assert.equal(ok(await api("POST", `/v1/admin/refunds/${rq2.id}/decision`, { token: fin, body: { approve: false, reason: "Dispute withdrawn" } })).status, "REJECTED");
  assert.ok((await cards(p2)).every((t: any) => t.status === "SOLD"));
  const rq2b = ok(await api("POST", `/v1/admin/orders/${order2}/refund`, { token: ct, body: { reason: "DISPUTED_PAYMENT", note: "Raised again" } }));

  // p4 starts paying just before the cycle is cancelled.
  const late = ok(await api("POST", "/v1/orders", { token: p4.token, key: key(), body: { cycleId: v.id, quantity: 1 } }));

  // --- Cancelling the cycle: one person asks, a different person decides. ---
  const url = `/v1/admin/cycles/${v.id}/void`;
  fails(await api("POST", url, { token: fin, body: { reason: "x" } }), 403, "ROLE_REQUIRED");
  ok(await api("POST", url, { token: mt, body: { reason: "Supplier failed to deliver" } }));
  fails(await api("POST", url, { token: ct, body: { reason: "duplicate" } }), 409, "VOID_ALREADY_REQUESTED");
  fails(await api("POST", `${url}/decision`, { token: mt, body: { approve: true } }), 403, "ROLE_REQUIRED");
  fails(await api("POST", `${url}/decision`, { token: admins.approver!.token, body: { approve: true } }), 403, "ROLE_REQUIRED");
  await assert.rejects(pool.query("UPDATE cycles SET status = 'VOID' WHERE id = $1", [v.id]), /approved void request/);
  fails(await api("POST", `${url}/decision`, { token: ct, body: { approve: false } }), 400, "REASON_REQUIRED");
  assert.equal(ok(await api("POST", `${url}/decision`, { token: ct, body: { approve: false, reason: "Replacement stock found" } })).status, "REJECTED");
  assert.equal(ok(await api("GET", `/v1/cycles/${v.id}`)).status, "OPEN");
  ok(await api("POST", url, { token: ct, body: { reason: "Regulator instruction" } }));
  fails(await api("POST", `${url}/decision`, { token: ct, body: { approve: true } }), 403, "SAME_PERSON");
  const voided = ok(await api("POST", `${url}/decision`, { token: fin, body: { approve: true } }));
  assert.deepEqual(voided, { status: "VOID", refunds: 2, refundedKobo: 7 * 50_000 });

  // Every remaining purchase refunded once; revenue back to zero; the books still balance.
  assert.equal(ok(await api("GET", `/v1/cycles/${v.id}`)).status, "VOID");
  assert.equal(await revenue(), 0);
  assert.equal((await pool.query("SELECT balance_kobo AS b FROM ledger_balances WHERE code = 'REFUNDS_PAYABLE'")).rows[0].b, 0);
  assert.equal((await pool.query("SELECT coalesce(sum(amount_kobo),0)::bigint AS s FROM ledger_entries")).rows[0].s, 0);
  assert.equal((await pool.query("SELECT status FROM refunds WHERE id = $1", [rq2b.id])).rows[0].status, "REJECTED"); // superseded
  for (const p of [p1, p2]) {
    const o = ok(await api("GET", "/v1/orders", { token: p.token })).orders[0];
    assert.equal(o.status, "REFUNDED"); assert.equal(o.refund_reason, "CYCLE_VOID");
  }
  // Instant prizes already revealed are honoured — accepted for the winner even though they never tapped Accept;
  // unscratched cards can no longer be revealed.
  assert.equal((await wallet(p1)).balanceKobo, w1);
  fails(await api("POST", `/v1/tickets/${p1Unscratched.id}/reveal`, { token: p1.token }), 409, "CARD_CANCELLED");
  // A payment that arrives after cancellation is never kept without a card: it goes straight into the player's wallet.
  assert.equal(ok(await api("POST", "/v1/simulated-gateway/pay", { token: p4.token, body: { paymentRef: late.paymentRef } })).status, "CREDITED_TO_WALLET");
  assert.equal((await wallet(p4)).balanceKobo, 50_000);
  // Merchandise goes back into stock for future cycles.
  assert.deepEqual((await pool.query("SELECT status, reserved_cycle_id FROM stock_units WHERE serial_number IN ('SN-7','SN-8') ORDER BY serial_number")).rows,
    [{ status: "IN_STOCK", reserved_cycle_id: null }, { status: "IN_STOCK", reserved_cycle_id: null }]);
  // Nothing more can happen on the cycle, and the regulator report is flagged.
  fails(await api("POST", "/v1/orders", { token: p4.token, key: key(), body: { cycleId: v.id, quantity: 1 } }), 409, "SALES_CLOSED");
  fails(await api("POST", `/v1/admin/cycles/${v.id}/draw/sign`, { token: mt }), 409, "NOT_CLOSED");
  const alert = (await pool.query("SELECT details FROM compliance_alerts WHERE kind = 'CYCLE_VOIDED' AND entity_id = $1", [v.id])).rows[0];
  assert.equal(alert.details.reportToRegulator, true); assert.equal(alert.details.reason, "Regulator instruction");
  const dash = ok(await api("GET", "/v1/admin/dashboard", { token: fin })).cycles.find((c: any) => c.id === v.id);
  assert.equal(dash.outstanding_instant_liability_kobo, 0); assert.equal(dash.final_draw_cash_commitment_kobo, 0);
  // A cycle whose draw has happened cannot be cancelled.
  fails(await api("POST", `/v1/admin/cycles/${cycleA.id}/void`, { token: mt, body: { reason: "too late" } }), 409, "NOT_VOIDABLE");
  // Every step is on the audit trail. (The chain was deliberately broken by an earlier test to prove tampering is detected.)
  const actions = (await pool.query("SELECT action FROM audit_log WHERE entity_id = ANY($1)", [[v.id, order2, order3]])).rows.map((r: any) => r.action);
  for (const a of ["refund.requested", "refund.approved", "refund.rejected", "cycle.void_requested", "cycle.void_rejected", "cycle.voided"]) assert.ok(actions.includes(a), a);
});

test("finance: expenses by reversal only, daily reconciliation catches a ledger that disagrees with the records, results and spreadsheet export", async () => {
  const fin = admins.finance!.token, mt = admins.manager!.token, aud = admins.auditor!.token;
  const today = (await pool.query("SELECT (now() AT TIME ZONE 'Africa/Lagos')::date::text AS d")).rows[0].d as string;

  // --- Operating expenses ---
  const exp = (token: string, b: object) => api("POST", "/v1/admin/finance/expenses", { token, body: b });
  fails(await exp(mt, { category: "TECHNOLOGY", description: "Hosting", amountKobo: 5_000_000, incurredOn: today }), 403, "ROLE_REQUIRED");
  fails(await exp(fin, { category: "TECHNOLOGY", description: "Hosting", amountKobo: 5_000_000, incurredOn: "2999-01-01" }), 400, "INVALID_DATE");
  const wrong = ok(await exp(fin, { category: "TECHNOLOGY", description: "Hosting (wrong cycle)", amountKobo: 5_000_000, incurredOn: today, cycleId: cycleA.id }));
  const rev = ok(await api("POST", `/v1/admin/finance/expenses/${wrong.id}/reverse`, { token: fin, body: { reason: "Entered against the wrong cycle" } }));
  fails(await api("POST", `/v1/admin/finance/expenses/${wrong.id}/reverse`, { token: fin, body: { reason: "again" } }), 409, "ALREADY_REVERSED");
  fails(await api("POST", `/v1/admin/finance/expenses/${rev.id}/reverse`, { token: fin, body: { reason: "undo" } }), 409, "NOT_REVERSIBLE");
  ok(await exp(fin, { category: "MARKETING", description: "Radio adverts, Minna", payee: "=cmd|' /C calc'!A0", amountKobo: 2_500_000, incurredOn: today, cycleId: cycleA.id, documentRef: "INV-77" }));
  ok(await exp(fin, { category: "LICENSING", description: "Legal advice on licensing", amountKobo: 3_000_000, incurredOn: today }));
  await assert.rejects(pool.query("UPDATE operating_expenses SET amount_kobo = 1 WHERE id = $1", [wrong.id]), /append-only/);
  await assert.rejects(pool.query("DELETE FROM operating_expenses WHERE id = $1", [wrong.id]), /append-only/);
  const opex = (await pool.query("SELECT code, balance_kobo FROM ledger_balances WHERE code LIKE 'OPEX:%' ORDER BY code")).rows;
  assert.deepEqual(opex, [{ code: "OPEX:LICENSING", balance_kobo: 3_000_000 }, { code: "OPEX:MARKETING", balance_kobo: 2_500_000 }, { code: "OPEX:TECHNOLOGY", balance_kobo: 0 }]);

  // --- Cycle results agree with the ledger and the stock records ---
  fails(await api("GET", "/v1/admin/finance/cycle-results", { token: admins.approver!.token }), 403, "ROLE_REQUIRED");
  const results = ok(await api("GET", "/v1/admin/finance/cycle-results", { token: aud })).cycles;
  for (const c of results) assert.equal(c.gross_sales_kobo - c.refunds_kobo, c.net_revenue_kobo, `sales less refunds = revenue for ${c.name}`);
  const a = results.find((c: any) => c.id === cycleA.id);
  assert.deepEqual([a.cards_sold, a.net_revenue_kobo, a.instant_prizes_kobo, a.draw_cash_prizes_kobo, a.forfeited_prizes_kobo, a.merchandise_cost_kobo, a.operating_expenses_kobo],
    [60, 60 * N200, 50_000, 200_000, 0, 2 * 40_000, 2_500_000]);
  assert.equal(a.contribution_kobo, 60 * N200 - 50_000 - 200_000 - 80_000 - 2_500_000);
  const voidCycle = results.find((c: any) => c.status === "VOID");
  assert.equal(voidCycle.net_revenue_kobo, 0); assert.equal(voidCycle.merchandise_cost_kobo, 0); assert.ok(voidCycle.refunds_kobo > 0);

  // --- Daily reconciliation ---
  const recon = (token: string, b: object) => api("POST", "/v1/admin/finance/reconciliations", { token, body: b });
  fails(await recon(mt, { day: today }), 403, "ROLE_REQUIRED");
  fails(await recon(fin, { day: "2999-01-01" }), 400, "INVALID_DATE");
  const r1 = ok(await recon(fin, { day: today }));
  assert.equal(r1.status, "MATCHED");
  const rec = r1.figures.records;
  assert.ok(rec.collectedKobo > 0 && rec.refundedKobo > 0 && rec.paidOutKobo > 0);
  assert.deepEqual(r1.figures.ledger, rec);
  // The provider's statement (entered by Finance) disagrees: flagged.
  const r2 = ok(await recon(fin, { day: today, statement: { ...rec, collectedKobo: rec.collectedKobo + 100 } }));
  assert.equal(r2.status, "MISMATCH");
  const alerts = async () => (await pool.query("SELECT count(*)::int AS n FROM compliance_alerts WHERE kind = 'RECONCILIATION_MISMATCH' AND entity_id = $1", [today])).rows[0].n;
  assert.equal(await alerts(), 1);
  assert.equal(ok(await recon(fin, { day: today, statement: rec })).status, "MATCHED");
  // Someone with database access slips an extra "sale" into the ledger without a payment behind it.
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("INSERT INTO ledger_accounts (code, kind) VALUES ('TICKET_REVENUE:tamper', 'REVENUE') ON CONFLICT DO NOTHING");
    const tx = (await c.query("INSERT INTO ledger_transactions (kind, reference) VALUES ('TICKET_SALE', 'tamper-1') RETURNING id")).rows[0].id;
    await c.query(`INSERT INTO ledger_entries (transaction_id, account_id, amount_kobo)
      SELECT $1, id, CASE WHEN code = 'GATEWAY_CLEARING' THEN 10000 ELSE -10000 END FROM ledger_accounts WHERE code IN ('GATEWAY_CLEARING', 'TICKET_REVENUE:tamper')`, [tx]);
    await c.query("COMMIT");
  } finally { c.release(); }
  const r4 = ok(await recon(fin, { day: today }));
  assert.equal(r4.status, "MISMATCH"); // the books still balance, but no longer agree with the payment records
  assert.equal(r4.figures.ledger.collectedKobo - r4.figures.records.collectedKobo, 10000);
  assert.equal(await alerts(), 1); // one open alert per day, not one per run
  fails(await api("POST", "/v1/admin/finance/reconciliations/sign-off", { token: fin, body: { day: today } }), 400, "NOTE_REQUIRED");
  fails(await api("POST", "/v1/admin/finance/reconciliations/sign-off", { token: mt, body: { day: today, note: "x" } }), 403, "ROLE_REQUIRED");
  ok(await api("POST", "/v1/admin/finance/reconciliations/sign-off", { token: fin, body: { day: today, note: "₦100 unexplained ledger entry tamper-1; escalated to Compliance" } }));
  fails(await recon(fin, { day: today }), 409, "SIGNED_OFF");
  fails(await api("POST", "/v1/admin/finance/reconciliations/sign-off", { token: fin, body: { day: today, note: "again" } }), 409, "SIGNED_OFF");
  await assert.rejects(pool.query("UPDATE reconciliations SET status = 'MATCHED' WHERE day = $1", [today]), /signed-off/);
  await assert.rejects(pool.query("DELETE FROM reconciliations WHERE day = $1", [today]), /signed-off/);
  const list = ok(await api("GET", "/v1/admin/finance/reconciliations", { token: aud }));
  assert.equal(list.days[0].day, today); assert.equal(list.days[0].status, "MISMATCH"); assert.ok(list.days[0].signed_off_by_name);
  assert.ok(!list.notReconciled.includes(today));

  // --- Period summary ---
  const s = ok(await api("GET", `/v1/admin/finance/summary?from=${today}&to=${today}`, { token: fin }));
  assert.equal(s.collected_kobo, rec.collectedKobo); assert.equal(s.refunded_kobo, rec.refundedKobo); assert.equal(s.paid_out_kobo, rec.paidOutKobo);
  assert.equal(s.operating_expenses_kobo, 5_500_000);
  assert.equal(s.result_kobo, s.collected_kobo + s.wallet_sales_kobo - s.refunded_kobo - s.refunded_to_wallets_kobo - s.cash_prizes_kobo - s.referral_commissions_kobo - s.affiliate_fees_kobo - s.operating_expenses_kobo);
  assert.equal(s.days_signed_off, 1); assert.equal(s.days_mismatched, 1);
  fails(await api("GET", `/v1/admin/finance/summary?from=${today}&to=2000-01-01`, { token: fin }), 400, "INVALID_DATE");

  // --- Spreadsheet export is safe to open ---
  ok(await api("POST", "/v1/admin/cycles", { token: mt, body: { name: '=HYPERLINK("http://evil.example","click")', ticketPriceKobo: N200, totalTickets: 10, maxTicketsPerAccount: 5,
    salesOpenAt: new Date().toISOString(), salesCloseAt: new Date(Date.now() + 864e5).toISOString(), drawAt: new Date(Date.now() + 864e5).toISOString() } }));
  const csvRes = await app.inject({ method: "GET", url: "/v1/admin/finance/cycle-results.csv", headers: { authorization: `Bearer ${fin}` } });
  assert.equal(csvRes.statusCode, 200);
  assert.match(String(csvRes.headers["content-type"]), /^text\/csv/);
  assert.match(String(csvRes.headers["content-disposition"]), /attachment; filename="cycle-results.csv"/);
  const lines = csvRes.body.replace(/^﻿/, "").trim().split("\r\n");
  assert.match(lines[0]!, /^Cycle,Status,Cards sold,/);
  assert.ok(lines.some((l) => l.startsWith(`"'=HYPERLINK(""http://evil.example"",""click"")"`)), "formula is neutralised");
  assert.ok(lines.some((l) => l.includes(String((60 * N200 - 2_830_000) / 100))), "negative contribution stays a number");
  const ex = await app.inject({ method: "GET", url: "/v1/admin/finance/expenses.csv", headers: { authorization: `Bearer ${fin}` } });
  assert.ok(ex.body.includes("'=cmd|"), "payee formula neutralised");
  assert.ok(ex.body.includes(",-50000,"), "reversal shown as a negative amount");
  assert.equal((await app.inject({ method: "GET", url: "/v1/admin/finance/expenses.csv", headers: { authorization: `Bearer ${admins.approver!.token}` } })).statusCode, 403);
});

test("close-out: blocked until every prize is resolved, two people, then every card is published and anyone can rebuild the fingerprint", async () => {
  const mt = admins.manager!.token, fin = admins.finance!.token;
  const b = (await pool.query("SELECT id FROM cycles WHERE name = 'Cycle B'")).rows[0].id as string;
  const readiness = async (id: string) => ok(await api("GET", `/v1/admin/cycles/${id}/archive`, { token: mt })).checks as { key: string; ok: boolean; detail: string }[];

  // One freezer prize is still waiting for its winner, inside the 90-day window.
  const before = await readiness(b);
  assert.deepEqual(before.map((c) => [c.key, c.ok]), [["drawn", true], ["claims", false], ["reconciled", true], ["alerts", true]]);
  const refused = await api("POST", `/v1/admin/cycles/${b}/archive/request`, { token: mt });
  fails(refused, 409, "NOT_READY");
  assert.match(refused.body.error.message, /waiting for the winner/);
  fails(await api("GET", `/v1/cycles/${b}/tickets`), 404, "NOT_FOUND"); // nothing published before archiving

  // Ninety days later, the unclaimed prize has lapsed.
  await pool.query(`UPDATE prize_claims SET expires_at = now() - interval '1 minute' WHERE status = 'ENTITLED'
    AND prize_tier_id IN (SELECT id FROM prize_tiers WHERE cycle_id = $1)`, [b]);
  const lapsed = await readiness(b);
  assert.ok(lapsed.every((c) => c.ok));
  assert.match(lapsed.find((c) => c.key === "claims")!.detail, /will be closed as expired/);

  fails(await api("POST", `/v1/admin/cycles/${b}/archive/request`, { token: fin }), 403, "ROLE_REQUIRED");
  assert.deepEqual(ok(await api("POST", `/v1/admin/cycles/${b}/archive/request`, { token: mt })), { status: "SETTLING", expiredClaims: 1 });
  fails(await api("POST", `/v1/admin/cycles/${b}/archive/request`, { token: mt }), 409, "NOT_DRAWN");
  fails(await api("POST", `/v1/admin/cycles/${b}/archive/confirm`, { token: mt }), 403, "ROLE_REQUIRED");
  fails(await api("POST", `/v1/admin/cycles/${b}/archive/confirm`, { token: admins.compliance!.token }), 403, "ROLE_REQUIRED");
  // Not even directly in the database can a cycle be archived without its cards published and a second person.
  await assert.rejects(pool.query("UPDATE cycles SET status = 'ARCHIVED', archived_by = archive_requested_by, archived_at = now() WHERE id = $1", [b]));

  const done = ok(await api("POST", `/v1/admin/cycles/${b}/archive/confirm`, { token: fin }));
  assert.deepEqual(done, { status: "ARCHIVED", published: 60, stockReleased: 2 });
  fails(await api("POST", `/v1/admin/cycles/${b}/archive/confirm`, { token: fin }), 409, "NOT_REQUESTED");
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM stock_units WHERE reserved_cycle_id = $1", [b])).rows[0].n, 0);
  assert.equal(ok(await api("GET", `/v1/cycles/${b}`)).status, "ARCHIVED");

  // Anyone, without signing in, can fetch every card and rebuild the fingerprint published before sales.
  const pub = ok(await api("GET", `/v1/cycles/${b}/tickets`));
  assert.equal(pub.total, 60); assert.equal(pub.tickets.length, 60);
  const leaves = pub.tickets.map((t: any) => ticketLeafHash({ cycleId: b, serial: t.serial, outcome: t.outcome, salt: Buffer.from(t.salt, "hex") }));
  assert.equal(new MerkleTree(leaves).root.toString("hex"), ok(await api("GET", `/v1/cycles/${b}`)).commitment.ticket_merkle_root);
  const count = (o: string) => pub.tickets.filter((t: any) => t.outcome === o).length;
  assert.deepEqual([count("CASH:50000"), count("NONE")], [1, 59]); // exactly the advertised prizes
  assert.deepEqual([pub.tickets.filter((t: any) => t.sale_status === "UNSOLD").length, pub.tickets.filter((t: any) => t.sale_status === "REVEALED").length], [55, 5]);
  // Cards revealed during the cycle match what was published at the end.
  for (const t of (await pool.query("SELECT serial, revealed_outcome FROM tickets WHERE cycle_id = $1 AND status = 'REVEALED'", [b])).rows) {
    assert.equal(pub.tickets.find((p: any) => p.serial === t.serial).outcome, t.revealed_outcome);
  }
  const page = ok(await api("GET", `/v1/cycles/${b}/tickets?offset=10&limit=5`));
  assert.deepEqual(page.tickets.map((t: any) => t.leaf_index), [10, 11, 12, 13, 14]);
  fails(await api("GET", `/v1/cycles/${b}/tickets?limit=9999`), 400, "INVALID_RANGE");

  // The record is permanent.
  await assert.rejects(pool.query("UPDATE published_tickets SET outcome = 'NONE' WHERE cycle_id = $1", [b]), /append-only/);
  await assert.rejects(pool.query("UPDATE cycles SET archived_by = $2 WHERE id = $1", [b, admins.compliance!.id]), /cannot be changed/);

  // cycleA still has a prize out for delivery (and its handover was locked), so it cannot be closed out.
  const a = await readiness(cycleA.id);
  assert.equal(a.find((c) => c.key === "claims")!.ok, false);
  assert.equal(a.find((c) => c.key === "alerts")!.ok, false);
  fails(await api("POST", `/v1/admin/cycles/${cycleA.id}/archive/request`, { token: mt }), 409, "NOT_READY");

  const actions = (await pool.query("SELECT action FROM audit_log WHERE entity_id = $1", [b])).rows.map((r: any) => r.action);
  assert.ok(actions.includes("cycle.archive_requested") && actions.includes("cycle.archived"));
});

test("sell-out rush: when more people order than there are cards, the extra orders are turned away before anyone pays", async () => {
  // 30 cards, 10 buyers of 5 each, ordering at the same instant: exactly 6 orders hold cards, 4 are told at once
  // that not enough are left, and all 6 payments get their cards. Nobody is refunded.
  for (let round = 0; round < 6; round++) {
    const ft = admins.fulfilment!.token;
    ok(await api("POST", "/v1/admin/stock/receive", { token: ft, body: { skuId, supplierId, warehouseId, poReference: `PO-R${round}`, serialNumbers: [`SN-R${round}-1`, `SN-R${round}-2`], acquisitionCostKobo: 1, landedCostKobo: 1 } }));
    const c = await openCycle({ total: 30, closeInMs: 3600_000, cap: 30, name: `Race ${round}` });
    const buyers = await Promise.all(Array.from({ length: 10 }, () => newPlayer()));
    const orders = await Promise.all(buyers.map((p) => api("POST", "/v1/orders", { token: p.token, key: key(), body: { cycleId: c.id, quantity: 5 } })));
    assert.deepEqual([orders.filter((o) => o.status === 200).length, orders.filter((o) => o.status === 409 && o.body.error.code === "NOT_ENOUGH_CARDS").length], [6, 4], `round ${round}`);
    const paid = await Promise.all(buyers.map((p, i) => [p, orders[i]!] as const).filter(([, o]) => o.status === 200)
      .map(([p, o]) => api("POST", "/v1/simulated-gateway/pay", { token: p.token, body: { paymentRef: o.body.paymentRef } })));
    assert.ok(paid.every((r) => ok(r).status === "FULFILLED"), `round ${round}`);
    const left = (await pool.query("SELECT count(*)::int AS n FROM tickets WHERE cycle_id = $1 AND status IN ('UNSOLD','RESERVED')", [c.id])).rows[0].n;
    assert.equal(left, 0);
    assert.equal(ok(await api("GET", `/v1/cycles/${c.id}`)).status, "CLOSED");
  }
});

test("notifications: every event tells the right person once, texts respect daytime and retry, and never carry secrets", async () => {
  // Daytime rule (Nigeria, UTC+1): texts that can wait go out between 08:00 and 20:00.
  const at = (iso: string) => new Date(iso);
  assert.equal(nextSendTime(at("2026-11-18T11:00:00Z"), false).toISOString(), "2026-11-18T11:00:00.000Z"); // 12:00 Lagos
  assert.equal(nextSendTime(at("2026-11-18T06:30:00Z"), false).toISOString(), "2026-11-18T07:00:00.000Z"); // 07:30 -> 08:00
  assert.equal(nextSendTime(at("2026-11-18T19:00:00Z"), false).toISOString(), "2026-11-19T07:00:00.000Z"); // 20:00 -> next 08:00
  assert.equal(nextSendTime(at("2026-12-31T22:30:00Z"), false).toISOString(), "2027-01-01T07:00:00.000Z"); // 23:30 New Year's Eve
  assert.equal(nextSendTime(at("2026-11-18T01:00:00Z"), true).toISOString(), "2026-11-18T01:00:00.000Z"); // urgent: at once

  const rows = async (where: string, params: unknown[] = []) => (await pool.query(`SELECT * FROM notifications WHERE ${where}`, params)).rows;
  // The final draw told each winner (in the app and by text) and everyone else in the app only.
  const winners = (await pool.query("SELECT t.id, t.owner_id FROM draw_winners w JOIN tickets t ON t.id = w.ticket_id WHERE w.cycle_id = $1", [cycleA.id])).rows;
  for (const w of winners) {
    const n = await rows("dedupe_key = $1", [`draw:${cycleA.id}:win:${w.id}`]);
    assert.deepEqual(n.map((x: any) => x.channel).sort(), ["IN_APP", "SMS"]);
    assert.ok(n.every((x: any) => x.user_id === w.owner_id && x.kind === "DRAW_WIN"));
  }
  const owners = (await pool.query("SELECT DISTINCT owner_id FROM tickets WHERE cycle_id = $1 AND owner_id IS NOT NULL", [cycleA.id])).rows.map((r: any) => r.owner_id);
  const losers = owners.filter((o: string) => !winners.some((w: any) => w.owner_id === o));
  assert.equal((await rows("kind = 'DRAW_RESULT' AND dedupe_key LIKE $1", [`draw:${cycleA.id}:result:%`])).length, losers.length);
  assert.equal((await rows("kind = 'DRAW_RESULT' AND channel = 'SMS'")).length, 0); // no texts to people who did not win

  // Money, merchandise, refunds, cancellations and security events each produced their messages.
  for (const kind of ["PAYOUT_SENT", "PAYOUT_PENDING", "PAYOUT_REJECTED", "PRIZE_DISPATCHED", "PRIZE_DELIVERED", "CLAIM_EXPIRED", "REFUND", "CYCLE_CANCELLED", "SECURITY"]) {
    assert.ok((await rows("kind = $1", [kind])).length > 0, kind);
  }
  assert.equal((await rows("kind = 'PRIZE_DISPATCHED' AND channel = 'SMS'")).length, 2);

  // A PIN reset warns the account holder at once.
  const victim = players[0]!;
  const otp = ok(await api("POST", "/v1/auth/otp", { body: { phone: victim.phone } }));
  // The one-time code went straight to the provider and is stored nowhere.
  assert.ok(messenger.sent.at(-1)!.text.startsWith(otp.devCode) && messenger.sent.at(-1)!.to === "+234" + victim.phone.slice(1));
  assert.equal((await rows("body LIKE $1", [`%${otp.devCode}%`])).length, 0);
  ok(await api("POST", "/v1/auth/register", { body: { phone: victim.phone, code: otp.devCode, pin: "582916" } }));
  victim.pin = "582916";
  victim.token = ok(await api("POST", "/v1/auth/login", { body: { phone: victim.phone, pin: victim.pin } })).token;
  const sec = await rows("user_id = $1 AND kind = 'SECURITY' AND title = 'Your PIN was changed'", [victim.id]);
  assert.equal(sec.length, 2);
  assert.ok(sec.find((x: any) => x.channel === "SMS").not_before <= new Date()); // urgent: not held for daytime

  // No text ever carries a PIN or a six-digit code (handover codes stay in the app).
  for (const m of await rows("channel = 'SMS'")) {
    assert.ok(!/(?<![\d,])\d{6}(?![\d,])/.test(m.body), m.body);
    assert.ok(m.body.endsWith("We will never ask for your PIN."));
    assert.ok(!/[^\x0A\x0D\x20-\x7E]/.test(m.body), "plain SMS characters only: " + m.body);
  }

  // Inbox: the player sees their own messages and can mark them read; nobody else can.
  const w0 = players.find((p) => p.id === winners[0].owner_id)!;
  const box = ok(await api("GET", "/v1/notifications", { token: w0.token }));
  assert.ok(box.unread > 0 && box.items.some((i: any) => i.kind === "DRAW_WIN"));
  const other = players.find((p) => p.id !== w0.id)!;
  ok(await api("POST", "/v1/notifications/read", { token: other.token, body: { ids: [box.items[0].id] } }));
  assert.equal(ok(await api("GET", "/v1/notifications", { token: w0.token })).unread, box.unread); // unchanged
  assert.equal(ok(await api("POST", "/v1/notifications/read", { token: w0.token, body: { ids: [box.items[0].id] } })).unread, box.unread - 1);
  assert.equal(ok(await api("POST", "/v1/notifications/read", { token: w0.token, body: {} })).unread, 0);

  // Delivery: due texts are sent once each; a provider outage is retried with a delay, then given up after five tries.
  await pool.query("UPDATE notifications SET not_before = now() WHERE status = 'QUEUED'"); // as if it were daytime
  const queued = (await rows("status = 'QUEUED'")).length;
  assert.ok(queued > 5);
  messenger.failNext = 1;
  const before = messenger.sent.length;
  const d1 = await deliverMessages(ctx, 1000);
  assert.equal(d1.sent, queued - 1);
  assert.equal(messenger.sent.length - before, queued - 1);
  const retry = (await rows("status = 'QUEUED'"))[0];
  assert.equal(retry.attempts, 1); assert.match(retry.last_error, /outage/); assert.ok(retry.not_before > new Date());
  assert.deepEqual(await deliverMessages(ctx), { sent: 0, failed: 0 }); // nothing sent twice; the retry waits its turn
  for (let i = 0; i < 4; i++) {
    messenger.failNext = 1;
    await pool.query("UPDATE notifications SET not_before = now() WHERE id = $1", [retry.id]);
    await deliverMessages(ctx);
  }
  const gaveUp = (await rows("id = $1", [retry.id]))[0];
  assert.deepEqual([gaveUp.status, gaveUp.attempts], ["FAILED", 5]);
  const payoutText = (await rows("kind = 'PAYOUT_SENT' AND channel = 'SMS' AND status = 'SENT'"))[0];
  const payee = (await pool.query("SELECT phone_e164 FROM users WHERE id = $1", [payoutText.user_id])).rows[0].phone_e164;
  assert.ok(messenger.sent.some((m) => m.to === payee && m.text === payoutText.body));
  await assert.rejects(pool.query("UPDATE notifications SET body = 'edited' WHERE id = $1", [retry.id]), /cannot be changed/);
  await assert.rejects(pool.query("DELETE FROM notifications WHERE id = $1", [retry.id]), /cannot be changed/);

  // Unclaimed-prize reminders at 7, 30, 60 and 80 days; only the latest due is sent, and each only once.
  const tier = (await pool.query("SELECT id FROM prize_tiers WHERE cycle_id = $1 AND kind = 'MERCHANDISE'", [cycleA.id])).rows[0].id;
  const t = (await pool.query("SELECT id, owner_id FROM tickets WHERE cycle_id = $1 AND id NOT IN (SELECT ticket_id FROM draw_winners) LIMIT 1", [cycleA.id])).rows[0];
  const claim = (await pool.query(`INSERT INTO prize_claims (ticket_id, stage, prize_tier_id, user_id, status, expires_at, created_at)
    VALUES ($1, 'FINAL_DRAW', $2, $3, 'ENTITLED', now() + interval '59 days', now() - interval '31 days') RETURNING id`, [t.id, tier, t.owner_id])).rows[0].id;
  assert.equal(await sendClaimReminders(ctx), 1);
  assert.equal(await sendClaimReminders(ctx), 0);
  assert.equal((await rows("dedupe_key = $1", [`claim:${claim}:reminder:30`])).length, 2);
  assert.equal((await rows("dedupe_key = $1", [`claim:${claim}:reminder:7`])).length, 0);
  assert.match((await rows("dedupe_key = $1 AND channel = 'IN_APP'", [`claim:${claim}:reminder:30`]))[0].body, /within 59 days/);
  await pool.query("UPDATE prize_claims SET created_at = now() - interval '61 days' WHERE id = $1", [claim]);
  assert.equal(await sendClaimReminders(ctx), 1);
  assert.equal((await rows("dedupe_key = $1", [`claim:${claim}:reminder:60`])).length, 2);

  // Support and Compliance can see what was texted; others cannot.
  const log = ok(await api("GET", "/v1/admin/messages", { token: admins.compliance!.token }));
  assert.ok(log.messages.length > 0 && log.messages.every((m: any) => /^…\d{4}$/.test(m.phone)));
  assert.equal(log.failed, 1);
  fails(await api("GET", "/v1/admin/messages", { token: admins.finance!.token }), 403, "ROLE_REQUIRED");
});

test("staff access and licensing: two security administrators for any change, verified records only for the real-money gate", async () => {
  const sec = admins.security!.token, sec2 = admins.security2!.token;
  fails(await api("GET", "/v1/admin/staff", { token: admins.finance!.token }), 403, "ROLE_REQUIRED");
  assert.ok(ok(await api("GET", "/v1/admin/staff", { token: admins.auditor!.token })).staff.length >= 10); // auditors can see who has access

  // A new account starts with no roles at all.
  fails(await api("POST", "/v1/admin/staff", { token: admins.compliance!.token, body: { email: "new@example.test", fullName: "New Person" } }), 403, "ROLE_REQUIRED");
  const newbie = ok(await api("POST", "/v1/admin/staff", { token: sec, body: { email: "New@Example.test", fullName: "New Person" } }));
  fails(await api("POST", "/v1/admin/staff", { token: sec, body: { email: "new@example.test", fullName: "Again" } }), 409, "EMAIL_IN_USE");
  const signIn = async (email: string) => api("POST", "/v1/admin/dev-login", { body: { email } });
  let nt = ok(await signIn("new@example.test")).token;
  fails(await api("GET", "/v1/admin/dashboard", { token: nt }), 403, "ROLE_REQUIRED");

  // Granting a role: one security administrator asks, another decides.
  const req = (token: string, b: object) => api("POST", "/v1/admin/staff/requests", { token, body: b });
  const decide = (token: string, id: string, b: object) => api("POST", `/v1/admin/staff/requests/${id}/decision`, { token, body: b });
  const g = ok(await req(sec, { adminUserId: newbie.id, action: "GRANT_ROLE", role: "FINANCE", reason: "New finance officer" }));
  fails(await req(sec, { adminUserId: newbie.id, action: "GRANT_ROLE", role: "FINANCE", reason: "again" }), 409, "ALREADY_REQUESTED");
  fails(await decide(sec, g.id, { approve: true }), 403, "SAME_PERSON");
  assert.deepEqual(ok(await api("GET", "/v1/admin/me", { token: nt })).roles, []); // nothing yet
  assert.equal(ok(await decide(sec2, g.id, { approve: true })).status, "APPROVED");
  fails(await decide(sec2, g.id, { approve: true }), 409, "ALREADY_DECIDED");
  assert.deepEqual(ok(await api("GET", "/v1/admin/me", { token: nt })).roles, ["FINANCE"]);
  // Separation of duties holds: finance cannot also approve payouts.
  const clash = await req(sec, { adminUserId: newbie.id, action: "GRANT_ROLE", role: "PAYOUT_APPROVER", reason: "help out" });
  fails(clash, 409, "ROLE_CONFLICT");
  assert.match(clash.body.error.message, /cannot be held together with finance/);
  // Nobody can change their own access, even directly in the database.
  fails(await req(sec, { adminUserId: admins.security!.id, action: "GRANT_ROLE", role: "COMPLIANCE", reason: "me" }), 403, "OWN_ACCESS");
  await assert.rejects(pool.query("INSERT INTO admin_access_requests (admin_user_id, action, role, reason, requested_by) VALUES ($1, 'GRANT_ROLE', 'FINANCE', 'x', $1)", [admins.security!.id]));
  // A rejected request changes nothing.
  const rv = ok(await req(sec, { adminUserId: newbie.id, action: "REVOKE_ROLE", role: "FINANCE", reason: "Moved team" }));
  fails(await decide(sec2, rv.id, { approve: false }), 400, "REASON_REQUIRED");
  assert.equal(ok(await decide(sec2, rv.id, { approve: false, reason: "Still needed this quarter" })).status, "REJECTED");
  assert.deepEqual(ok(await api("GET", "/v1/admin/me", { token: nt })).roles, ["FINANCE"]);

  // There must always be two security administrators.
  fails(await api("POST", `/v1/admin/staff/${admins.security2!.id}/disable`, { token: sec, body: { reason: "test" } }), 409, "LAST_SECURITY_ADMINS");
  fails(await api("POST", `/v1/admin/staff/${admins.security!.id}/disable`, { token: sec, body: { reason: "test" } }), 403, "OWN_ACCESS");

  // Disabling is immediate and needs one person; it ends every session at once. Re-enabling needs two.
  fails(await api("POST", `/v1/admin/staff/${newbie.id}/disable`, { token: sec, body: { reason: " " } }), 400, "REASON_REQUIRED");
  ok(await api("POST", `/v1/admin/staff/${newbie.id}/disable`, { token: sec, body: { reason: "Laptop reported stolen" } }));
  fails(await api("GET", "/v1/admin/me", { token: nt }), 401, "UNAUTHENTICATED");
  fails(await signIn("new@example.test"), 401, "UNAUTHENTICATED");
  const en = ok(await req(sec, { adminUserId: newbie.id, action: "ENABLE", reason: "New laptop issued" }));
  fails(await decide(sec, en.id, { approve: true }), 403, "SAME_PERSON");
  ok(await decide(sec2, en.id, { approve: true }));
  nt = ok(await signIn("new@example.test")).token;
  assert.deepEqual(ok(await api("GET", "/v1/admin/me", { token: nt })).roles, ["FINANCE"]);
  const actions = (await pool.query("SELECT action FROM audit_log WHERE entity_id = $1", [newbie.id])).rows.map((r: any) => r.action);
  for (const a of ["access.staff_created", "access.change_requested", "access.change_approved", "access.change_rejected", "access.staff_disabled"]) assert.ok(actions.includes(a), a);

  // --- Licences and certifications: recorded by Compliance, verified by someone else ---
  const ct = admins.compliance!.token, fin = admins.finance!.token;
  fails(await api("POST", "/v1/admin/licences", { token: fin, body: { stateCode: "NG-NI", authority: "x", licenceNumber: "x", validFrom: "2026-01-01", validTo: "2027-01-01", documentRef: "x" } }), 403, "ROLE_REQUIRED");
  fails(await api("POST", "/v1/admin/licences", { token: ct, body: { stateCode: "NG-NI", authority: "x", licenceNumber: "x", validFrom: "2027-01-01", validTo: "2026-01-01", documentRef: "x" } }), 400, "INVALID_DATE");
  const today = new Date().toISOString().slice(0, 10), nextYear = new Date(Date.now() + 365 * 864e5).toISOString().slice(0, 10);
  const lic = ok(await api("POST", "/v1/admin/licences", { token: ct, body: { stateCode: "NG-NI", authority: "Niger State lottery authority (test)", licenceNumber: "NSL-TEST-1", validFrom: today, validTo: nextYear, documentRef: "docs/licence-test.pdf" } }));
  // A certificate for an older build of the engine (here: the bare release label) must not count.
  const stale = ok(await api("POST", "/v1/admin/certifications", { token: ct, body: { component: "GAME_CORE", componentVersion: "game-core@0.1.0", lab: "Test lab", certificateRef: "CERT-OLD", validFrom: today } }));
  ok(await api("POST", `/v1/admin/certifications/${stale.id}/verify`, { token: fin }));
  const cert = ok(await api("POST", "/v1/admin/certifications", { token: ct, body: { component: "GAME_CORE", componentVersion: GAME_CORE_VERSION, lab: "Test lab", certificateRef: "CERT-1", validFrom: today } }));
  let gate = ok(await api("GET", "/v1/admin/licensing", { token: admins.auditor!.token })).gate;
  assert.deepEqual(gate, { state: "NG-NI", licenceInForce: false, engineCertified: false, realMoneyAvailable: false }); // recorded is not enough

  // Even working directly in the database, a real-money cycle cannot open until both records are verified.
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    const cy = (await db.query(`INSERT INTO cycles (name, mode, ticket_price_kobo, total_tickets, max_tickets_per_account, sales_open_at, sales_close_at, draw_at, created_by)
      VALUES ('Real money test', 'REAL_MONEY', 20000, 10, 5, now() - interval '1 minute', now() + interval '1 day', now() + interval '1 day', $1) RETURNING id`, [admins.manager!.id])).rows[0].id;
    await db.query("UPDATE cycles SET status = 'SUBMITTED' WHERE id = $1", [cy]);
    await db.query("INSERT INTO cycle_approvals (cycle_id, approver_id, capacity) VALUES ($1, $2, 'OPERATIONS'), ($1, $3, 'FINANCE')", [cy, admins.manager2!.id, admins.finance!.id]);
    await db.query(`UPDATE cycles SET status = 'APPROVED', financial_model_ref = 'fm', rules_document_ref = 'r', rules_sha256 = sha256('r'), auditor_admin_id = $2,
      escrow_reference = 'E', escrow_funded_kobo = 0 WHERE id = $1`, [cy, admins.auditor!.id]);
    await db.query("INSERT INTO cycle_commitments (cycle_id, game_core_version, ticket_merkle_root, prize_table_sha256, draw_secret_commitment, kms_key_ref) VALUES ($1, $2, sha256('a'), sha256('b'), sha256('c'), 'k')", [cy, GAME_CORE_VERSION]);
    await db.query("UPDATE cycles SET status = 'COMMITTED' WHERE id = $1", [cy]);
    const tryOpen = async () => {
      await db.query("SAVEPOINT s");
      try { await db.query("UPDATE cycles SET status = 'OPEN' WHERE id = $1", [cy]); return "OPEN"; }
      catch (e) { return (e as Error).message; }
      finally { await db.query("ROLLBACK TO SAVEPOINT s"); }
    };
    assert.match(await tryOpen(), /no verified licence/);

    fails(await api("POST", `/v1/admin/licences/${lic.id}/verify`, { token: ct }), 403, "SAME_PERSON");
    fails(await api("POST", `/v1/admin/licences/${lic.id}/verify`, { token: admins.approver!.token }), 403, "ROLE_REQUIRED");
    ok(await api("POST", `/v1/admin/licences/${lic.id}/verify`, { token: fin }));
    fails(await api("POST", `/v1/admin/licences/${lic.id}/verify`, { token: fin }), 409, "NOT_PENDING");
    assert.match(await tryOpen(), /no verified certification/);
    ok(await api("POST", `/v1/admin/certifications/${cert.id}/verify`, { token: fin }));
    assert.equal(await tryOpen(), "OPEN"); // both verified: the gate opens (the API still cannot take real money in Phase 2)

    fails(await api("POST", `/v1/admin/licences/${lic.id}/revoke`, { token: ct, body: { reason: " " } }), 400, "REASON_REQUIRED");
    ok(await api("POST", `/v1/admin/licences/${lic.id}/revoke`, { token: ct, body: { reason: "Authority suspended the licence" } }));
    assert.match(await tryOpen(), /no verified licence/); // revoked: shut again
    await db.query("ROLLBACK");
  } finally { db.release(); }

  gate = ok(await api("GET", "/v1/admin/licensing", { token: ct })).gate;
  assert.deepEqual([gate.licenceInForce, gate.engineCertified, gate.realMoneyAvailable], [false, true, false]);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM compliance_alerts WHERE kind = 'LICENCE_REVOKED' AND entity_id = $1", [lic.id])).rows[0].n, 1);
  // The records themselves cannot be rewritten or removed.
  await assert.rejects(pool.query("UPDATE licences SET valid_to = '2099-01-01' WHERE id = $1", [lic.id]), /cannot be changed/);
  await assert.rejects(pool.query("UPDATE licences SET status = 'VERIFIED' WHERE id = $1", [lic.id]), /cannot be changed/);
  await assert.rejects(pool.query("DELETE FROM certifications WHERE id = $1", [cert.id]), /cannot be deleted/);
});

test("large deliveries and rate limits behind a load balancer", async () => {
  // A delivery of 3,000 serial-numbered items fits in one request.
  const ft = admins.fulfilment!.token;
  const serials = Array.from({ length: 3000 }, (_, i) => `SN-BULK-${String(i).padStart(6, "0")}`);
  assert.deepEqual(ok(await api("POST", "/v1/admin/stock/receive", { token: ft, body: { skuId, supplierId, warehouseId, poReference: "PO-BULK", serialNumbers: serials, acquisitionCostKobo: 1, landedCostKobo: 1 } })), { received: 3000 });

  const count429 = async (server: FastifyInstance, from: (i: number) => { remoteAddress: string; xff?: string }) => {
    let n = 0;
    for (let i = 0; i < 15; i++) {
      const f = from(i);
      const r = await server.inject({ method: "GET", url: "/health", remoteAddress: f.remoteAddress, ...(f.xff ? { headers: { "x-forwarded-for": f.xff } } : {}) });
      if (r.statusCode === 429) n++;
    }
    return n;
  };
  const limits = { auth: 100, general: 10 };
  // Behind one load balancer, with the proxy configured: each player has their own allowance.
  const proxied = buildServer({ ...ctx, config: { ...config, rateLimits: limits, trustedProxies: 1 } });
  assert.equal(await count429(proxied, (i) => ({ remoteAddress: "10.0.0.1", xff: `41.58.1.${i}` })), 0);
  // ...and one player sending many requests is still limited.
  assert.equal(await count429(proxied, () => ({ remoteAddress: "10.0.0.1", xff: "41.58.9.9" })), 5);
  // ...even if they put invented addresses in front of the one the load balancer adds.
  assert.equal(await count429(proxied, (i) => ({ remoteAddress: "10.0.0.1", xff: `6.6.6.${i}, 41.58.8.8` })), 5);
  await proxied.close();
  // Reached directly, a forged address header is ignored: a client cannot dodge the limit by inventing addresses.
  const direct = buildServer({ ...ctx, config: { ...config, rateLimits: limits, trustedProxies: 0 } });
  assert.equal(await count429(direct, (i) => ({ remoteAddress: "41.58.7.7", xff: `1.2.3.${i}` })), 5);
  await direct.close();
});

test("next-of-kin claims: only the recorded next of kin, the winner told first, a waiting period, two people, then prizes and winnings move", async () => {
  const ct = admins.compliance!.token, fin = admins.finance!.token;
  const { expireClaims } = await import("../src/modules/inventory.ts");
  // A real drawn cycle: the winner holds every entry, so wins the cash prize and both freezers.
  ok(await api("POST", "/v1/admin/stock/receive", { token: admins.fulfilment!.token, body: { skuId, supplierId, warehouseId, poReference: "PO-NOK", serialNumbers: ["SN-NOK-1", "SN-NOK-2"], acquisitionCostKobo: 1, landedCostKobo: 1 } }));
  const cyc = await openCycle({ total: 30, closeInMs: 2500, cap: 12, name: "Kin cycle" });
  const winner = await newPlayer();
  const claimant = await newPlayer({ name: "Kin Claimant" });
  const stranger = await newPlayer();
  ok(await api("PUT", "/v1/me/next-of-kin", { token: winner.token, body: { fullName: "Kin Claimant", relationship: "Brother", phone: claimant.phone } }));
  await buy(winner, cyc.id, 5);
  await sleep(Math.max(0, cyc.closeAt - Date.now()) + 2200);
  await closeDueCycles(ctx);
  for (const a of ["manager", "finance", "auditor"]) ok(await api("POST", `/v1/admin/cycles/${cyc.id}/draw/sign`, { token: admins[a]!.token }));
  ok(await api("POST", `/v1/admin/cycles/${cyc.id}/draw/execute`, { token: admins.manager!.token }));
  const winnings = ok(await api("GET", "/v1/wallet", { token: winner.token })).balanceKobo;
  assert.ok(winnings >= 100_000);

  const look = ok(await api("GET", `/v1/admin/nok/lookup?phone=${winner.phone}`, { token: ct }));
  assert.equal(look.waitingPrizes.length, 2); assert.equal(look.winningsKobo, winnings);
  assert.deepEqual(look.nextOfKin, { name: "Kin Claimant", relationship: "Brother", phone: "…" + claimant.phone.slice(-4) });

  const open = (token: string, b: object) => api("POST", "/v1/admin/nok/cases", { token, body: { winnerPhone: winner.phone, claimantPhone: claimant.phone, reason: "UNREACHABLE", documents: ["calls-log.pdf", "claimant-id.pdf"], note: "No answer to calls or texts for 60 days", ...b } });
  fails(await open(fin, {}), 403, "ROLE_REQUIRED");
  fails(await open(ct, { documents: [" "] }), 400, "DOCUMENTS_REQUIRED");
  fails(await open(ct, { claimantPhone: stranger.phone }), 409, "NOT_NEXT_OF_KIN");
  await pool.query("UPDATE next_of_kin SET full_name = 'Someone Else' WHERE user_id = $1", [winner.id]);
  fails(await open(ct, {}), 409, "NAME_MISMATCH");
  await pool.query("UPDATE next_of_kin SET full_name = 'Kin Claimant' WHERE user_id = $1", [winner.id]);
  const c1 = ok(await open(ct, {}));
  fails(await open(ct, {}), 409, "CASE_ALREADY_OPEN");
  // The winner is told at once, by text and in the app.
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND kind = 'NOK_CASE_OPENED'", [winner.id])).rows[0].n, 2);

  const decide = (token: string, id: string, b: object) => api("POST", `/v1/admin/nok/cases/${id}/decision`, { token, body: b });
  fails(await decide(fin, c1.id, { approve: true }), 409, "WAITING_PERIOD");
  fails(await decide(ct, c1.id, { approve: true }), 403, "SAME_PERSON");
  // While the case is open the prizes cannot lapse, even past their window.
  await pool.query("UPDATE prize_claims SET expires_at = now() - interval '1 minute' WHERE user_id = $1 AND status = 'ENTITLED'", [winner.id]);
  await expireClaims(ctx);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM prize_claims WHERE user_id = $1 AND status = 'ENTITLED'", [winner.id])).rows[0].n, 2);
  await pool.query("UPDATE prize_claims SET expires_at = now() + interval '5 days' WHERE user_id = $1 AND status = 'ENTITLED'", [winner.id]);

  // A week later — but the winner has signed in, so they are reachable: the case cannot go ahead.
  await pool.query("UPDATE next_of_kin_cases SET opened_at = now() - interval '8 days' WHERE id = $1", [c1.id]);
  ok(await api("POST", "/v1/auth/login", { body: { phone: winner.phone, pin: winner.pin } }));
  fails(await decide(fin, c1.id, { approve: true }), 409, "WINNER_ACTIVE");
  fails(await decide(fin, c1.id, { approve: false }), 400, "REASON_REQUIRED");
  assert.equal(ok(await decide(fin, c1.id, { approve: false, reason: "Winner signed in; contacted directly" })).status, "REJECTED");
  fails(await decide(fin, c1.id, { approve: true }), 409, "ALREADY_DECIDED");

  // A second case, for a winner who has died; no sign-in after it is opened.
  await pool.query("UPDATE sessions SET created_at = now() - interval '9 days' WHERE user_id = $1", [winner.id]);
  const c2 = ok(await open(ct, { reason: "DECEASED", documents: ["death-certificate.pdf", "claimant-id.pdf"], note: "Death certificate seen at the Minna office" }));
  await pool.query("UPDATE next_of_kin_cases SET opened_at = now() - interval '8 days' WHERE id = $1", [c2.id]);
  const done = ok(await decide(fin, c2.id, { approve: true }));
  assert.equal(done.status, "APPROVED");
  assert.equal(done.transferred.prizeClaims.length, 2);
  assert.equal(done.transferred.winningsKobo, winnings);

  // The prizes and the winnings are now the claimant's, with time to complete the claim.
  const claims = ok(await api("GET", "/v1/claims", { token: claimant.token })).claims;
  assert.equal(claims.filter((x: any) => x.claimed_by_next_of_kin && x.status === "ENTITLED").length, 2);
  assert.ok(claims.every((x: any) => new Date(x.expires_at).getTime() > Date.now() + 29 * 864e5));
  assert.equal(ok(await api("GET", "/v1/wallet", { token: claimant.token })).balanceKobo, winnings);
  assert.equal(0 - (await pool.query("SELECT coalesce(sum(e.amount_kobo),0)::bigint AS b FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id WHERE a.code = $1", [`PLAYER_WINNINGS:${winner.id}`])).rows[0].b, 0);
  // The deceased winner's account is closed to sign-in.
  fails(await api("GET", "/v1/me", { token: winner.token }), 401, "UNAUTHENTICATED");
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND kind = 'NOK_APPROVED'", [claimant.id])).rows[0].n, 2);

  const list = ok(await api("GET", "/v1/admin/nok/cases", { token: admins.auditor!.token })).cases;
  assert.deepEqual(list.filter((x: any) => [c1.id, c2.id].includes(x.id)).map((x: any) => x.status).sort(), ["APPROVED", "REJECTED"]);
  await assert.rejects(pool.query("UPDATE next_of_kin_cases SET claimant_user_id = $2 WHERE id = $1", [c2.id, stranger.id]), /cannot be changed/);
  await assert.rejects(pool.query("DELETE FROM next_of_kin_cases WHERE id = $1", [c1.id]), /cannot be changed/);
  const actions = (await pool.query("SELECT action FROM audit_log WHERE entity_id = $1", [winner.id])).rows.map((r: any) => r.action);
  for (const a of ["nok.case_opened", "nok.case_rejected", "nok.case_approved"]) assert.ok(actions.includes(a), a);
});

test("support: requests and replies, what staff can see, and locking an account on a suspected takeover", async () => {
  const sp = admins.support!.token, ct = admins.compliance!.token, ct2 = admins.compliance2!.token;
  const p = await newPlayer({ name: "Support Player" });
  const other = await newPlayer();
  const open = (who: Player, b: object) => api("POST", "/v1/support/tickets", { token: who.token, body: { topic: "PAYMENT", subject: "Card not received", message: "I paid but no cards", ...b } });
  const t1 = ok(await open(p, {}));
  fails(await open(p, { message: "   " }), 400, "MESSAGE_REQUIRED");
  // Someone else cannot read or add to it.
  fails(await api("POST", `/v1/support/tickets/${t1.id}/messages`, { token: other.token, body: { message: "hi" } }), 404, "NOT_FOUND");
  assert.equal(ok(await api("GET", "/v1/support/tickets", { token: other.token })).tickets.length, 0);
  // A complaint also goes straight to Compliance.
  const c = ok(await open(p, { topic: "COMPLAINT", subject: "Unfair treatment", message: "I want to complain" }));
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM compliance_alerts WHERE kind = 'PLAYER_COMPLAINT' AND entity_id = $1", [c.id])).rows[0].n, 1);
  // At most five open requests per player.
  for (let i = 0; i < 3; i++) ok(await open(p, { subject: `Extra ${i}` }));
  fails(await open(p, { subject: "Sixth" }), 409, "TOO_MANY_OPEN");

  // Staff queue and reply. Finance has no access.
  fails(await api("GET", "/v1/admin/support/tickets", { token: admins.finance!.token }), 403, "ROLE_REQUIRED");
  const q = ok(await api("GET", "/v1/admin/support/tickets", { token: sp })).tickets;
  assert.ok(q.find((t: any) => t.id === c.id).escalated);
  assert.ok(q.every((t: any) => /^…\d{4}$/.test(t.player_phone)));
  assert.equal(ok(await api("POST", `/v1/admin/support/tickets/${t1.id}/reply`, { token: sp, body: { message: "Your payment was refunded on the same day; reference SIMRF-123." } })).status, "WAITING_PLAYER");
  // The text says only that a reply is waiting — the reply stays in the app.
  const sms = (await pool.query("SELECT body FROM notifications WHERE user_id = $1 AND kind = 'SUPPORT_REPLY' AND channel = 'SMS'", [p.id])).rows;
  assert.equal(sms.length, 1); assert.ok(!sms[0].body.includes("SIMRF"));
  let mine = ok(await api("GET", "/v1/support/tickets", { token: p.token })).tickets.find((t: any) => t.id === t1.id);
  assert.deepEqual(mine.messages.map((m: any) => m.author), ["PLAYER", "STAFF"]);
  assert.ok(!JSON.stringify(mine).includes("support@example.test") && mine.messages.every((m: any) => !("staff_name" in m)), "players do not see staff names");
  ok(await api("POST", `/v1/support/tickets/${t1.id}/messages`, { token: p.token, body: { message: "Thank you, I see it now." } }));
  assert.equal(ok(await api("GET", `/v1/admin/support/tickets/${t1.id}`, { token: sp })).status, "OPEN");
  ok(await api("POST", `/v1/admin/support/tickets/${t1.id}/reply`, { token: sp, body: { message: "Glad to help.", close: true } }));
  fails(await api("POST", `/v1/support/tickets/${t1.id}/messages`, { token: p.token, body: { message: "one more" } }), 409, "TICKET_CLOSED");
  fails(await api("POST", `/v1/admin/support/tickets/${t1.id}/escalate`, { token: ct, body: { reason: "x" } }), 403, "ROLE_REQUIRED");
  ok(await api("POST", `/v1/admin/support/tickets/${t1.id}/escalate`, { token: sp, body: { reason: "Player reports a second payment missing" } }));
  fails(await api("POST", `/v1/admin/support/tickets/${t1.id}/escalate`, { token: sp, body: { reason: "again" } }), 409, "ALREADY_ESCALATED");
  await assert.rejects(pool.query("UPDATE support_messages SET body = 'edited' WHERE ticket_id = $1", [t1.id]), /append-only/);

  // The player record support sees: enough to help, nothing that would let them impersonate the player.
  const sum = ok(await api("GET", `/v1/admin/support/player?phone=${p.phone}`, { token: sp }));
  assert.equal(sum.player.name, "Support Player"); assert.match(sum.player.phone, /^…\d{4}$/);
  const dump = JSON.stringify(sum);
  assert.ok(!dump.includes(p.phone.slice(1)) && !/identity_hash|account_number|pin_hash|outcome_ciphertext/.test(dump));
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM audit_log WHERE action = 'support.player_viewed' AND entity_id = $1", [p.id])).rows[0].n, 1);

  // Locking on a suspected takeover: one person, at once. Unlocking: a different Compliance officer.
  fails(await api("POST", `/v1/admin/support/player/${p.id}/lock`, { token: admins.finance!.token, body: { reason: "x" } }), 403, "ROLE_REQUIRED");
  ok(await api("POST", `/v1/admin/support/player/${p.id}/lock`, { token: sp, body: { reason: "Player called: phone stolen" } }));
  fails(await api("GET", "/v1/me", { token: p.token }), 401, "UNAUTHENTICATED"); // signed out everywhere
  fails(await api("POST", "/v1/auth/login", { body: { phone: p.phone, pin: "000001" } }), 401, "UNAUTHENTICATED"); // a stranger learns nothing
  fails(await api("POST", "/v1/auth/login", { body: { phone: p.phone, pin: p.pin } }), 403, "ACCOUNT_LOCKED"); // the owner is told
  // A thief with the SIM cannot get in by resetting the PIN with a text code.
  const otp = ok(await api("POST", "/v1/auth/otp", { body: { phone: p.phone } }));
  fails(await api("POST", "/v1/auth/register", { body: { phone: p.phone, code: otp.devCode, pin: "692047" } }), 403, "ACCOUNT_UNAVAILABLE");
  fails(await api("POST", `/v1/admin/support/player/${p.id}/unlock`, { token: sp, body: { reason: "x" } }), 403, "ROLE_REQUIRED");
  ok(await api("POST", `/v1/admin/support/player/${p.id}/unlock`, { token: ct, body: { reason: "Identity confirmed in person at the Minna office" } }));
  p.token = ok(await api("POST", "/v1/auth/login", { body: { phone: p.phone, pin: p.pin } })).token;
  ok(await api("GET", "/v1/me", { token: p.token }));
  // The person who locked an account cannot unlock it.
  ok(await api("POST", `/v1/admin/support/player/${other.id}/lock`, { token: ct, body: { reason: "Unusual withdrawals" } }));
  fails(await api("POST", `/v1/admin/support/player/${other.id}/unlock`, { token: ct, body: { reason: "x" } }), 403, "SAME_PERSON");
  ok(await api("POST", `/v1/admin/support/player/${other.id}/unlock`, { token: ct2, body: { reason: "Checked with the player" } }));
  await assert.rejects(pool.query("DELETE FROM player_locks WHERE user_id = $1", [p.id]), /cannot be changed/);
  assert.ok((await pool.query("SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND title = 'Your account has been locked'", [p.id])).rows[0].n >= 1);
});

test("language: a Hausa player's codes, texts and in-app messages are in Hausa, texts stay in the cheap SMS character set, and the choice can change", async () => {
  const gsm = /^[A-Za-z0-9 \n.,:;!?'"()\-+/&%#*=@_<>]*$/; // characters that keep a text in the standard SMS format
  const seq = ++phoneSeq;
  const phone = "0803" + String(1000000 + seq);
  fails(await api("POST", "/v1/auth/otp", { body: { phone, language: "fr" } }), 400, "INVALID_REQUEST");
  const otp = ok(await api("POST", "/v1/auth/otp", { body: { phone, language: "ha" } }));
  const codeText = messenger.sent.at(-1)!.text;
  assert.ok(codeText.startsWith(`${otp.devCode} ita ce lambar WiiFarm Rewards`), codeText);
  assert.match(codeText, gsm);
  const reg = ok(await api("POST", "/v1/auth/register", { body: { phone, code: otp.devCode, pin: "482915", language: "ha" } }));
  const token = reg.token;
  assert.equal(ok(await api("GET", "/v1/me", { token })).language, "ha");
  ok(await api("POST", "/v1/me/verify", { token, body: { kind: "NIN", number: String(10000000000 + seq), fullName: "Hadiza Lawal", dateOfBirth: "1991-02-03", stateCode: "NG-NI" } }));

  // A security alert, in Hausa in the app (with the proper letters) and by text (without them).
  ok(await api("POST", "/v1/me/bank-accounts", { token, body: { bankCode: "058", accountNumber: "0123456711", accountName: "Hadiza Lawal" } }));
  const latest = async (channel: string) => (await pool.query("SELECT title, body FROM notifications WHERE user_id = $1 AND channel = $2 ORDER BY created_at DESC, id DESC LIMIT 1", [reg.userId, channel])).rows[0];
  assert.equal((await latest("IN_APP")).title, "An ƙara asusun banki");
  const sms = (await latest("SMS")).body as string;
  assert.ok(sms.startsWith("An kara asusun banki mai karewa da 6711"), sms);
  assert.ok(sms.endsWith("Ba za mu taba tambayar PIN dinka ba."), sms);
  assert.match(sms, gsm);

  // Switching to English: later messages are in English; the change is on the record.
  fails(await api("PUT", "/v1/me/language", { token, body: { language: "xx" } }), 400, "INVALID_REQUEST");
  ok(await api("PUT", "/v1/me/language", { token, body: { language: "en" } }));
  ok(await api("POST", "/v1/me/bank-accounts", { token, body: { bankCode: "058", accountNumber: "0123456722", accountName: "Hadiza Lawal" } }));
  assert.equal((await latest("IN_APP")).title, "Bank account added");
  assert.ok(((await latest("SMS")).body as string).endsWith("We will never ask for your PIN."));
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM audit_log WHERE action = 'player.language_set' AND entity_id = $1", [reg.userId])).rows[0].n, 1);

  // Players who never chose read English, as before.
  const other = await newPlayer();
  assert.equal(ok(await api("GET", "/v1/me", { token: other.token })).language, "en");
});

test("invite codes and the wallet: every player can invite friends, which is counted but earns nothing; wallet spending with the PIN", async () => {
  const { accounts, post } = await import("../src/ledger.ts");
  const fin = admins.finance!.token, ct = admins.compliance!.token;
  const cyc = await openCycle({ total: 60, closeInMs: 3600_000, cap: 25, name: "Referral cycle" });
  const balanceOf = async (code: string) => Number((await pool.query("SELECT coalesce(balance_kobo, 0)::bigint AS b FROM ledger_balances WHERE code = $1", [code])).rows[0]?.b ?? 0);
  const wallet = async (p: { token: string }) => ok(await api("GET", "/v1/wallet", { token: p.token }));

  // Every player has a code without signing up for anything; the short link opens the app with it.
  const r = await newPlayer();
  const mine = ok(await api("GET", "/v1/me/referrals", { token: r.token }));
  assert.match(mine.code, /^[A-HJ-NP-Z2-9]{7}$/); assert.equal(mine.link, `/r/${mine.code}`); assert.equal(mine.ratePercent, undefined);
  const link = await app.inject({ method: "GET", url: `/r/${mine.code.toLowerCase()}` });
  assert.equal(link.statusCode, 302); assert.equal(link.headers.location, `/?ref=${mine.code}`);
  assert.equal((await app.inject({ method: "GET", url: "/r/<script>" })).headers.location, "/");

  // A friend signs up with the code. A wrong code is refused and leaves the sign-up code usable.
  const seq = ++phoneSeq, phone = "0803" + String(1000000 + seq);
  const otp = ok(await api("POST", "/v1/auth/otp", { body: { phone } }));
  fails(await api("POST", "/v1/auth/register", { body: { phone, code: otp.devCode, pin: "482915", referralCode: "ZZZZZZZ" } }), 400, "INVALID_REFERRAL");
  fails(await api("POST", "/v1/auth/register", { body: { phone, code: otp.devCode, pin: "482915", referralCode: "ZZZZZZZZ" } }), 400, "INVALID_REFERRAL");
  const reg = ok(await api("POST", "/v1/auth/register", { body: { phone, code: otp.devCode, pin: "482915", referralCode: ` ${mine.code.toLowerCase().slice(0, 3)} ${mine.code.toLowerCase().slice(3)} ` } }));
  const f = { token: reg.token, phone, pin: "482915", id: reg.userId };
  ok(await api("POST", "/v1/me/verify", { token: f.token, body: { kind: "NIN", number: String(10000000000 + seq), fullName: "Referred Friend", dateOfBirth: "1990-05-17", stateCode: "NG-NI" } }));
  await assert.rejects(pool.query("UPDATE users SET referred_by = NULL WHERE id = $1", [f.id]), /cannot be changed/);
  await assert.rejects(pool.query("UPDATE users SET referral_code = 'AAAAAAA' WHERE id = $1", [r.id]), /cannot be changed/);

  // The friend buys: counted on the inviter's page, but nothing is paid (the board adopted the SRS affiliate model).
  await buy(f, cyc.id, 10);
  assert.equal((await wallet(r)).balanceKobo, 0);
  assert.equal(await balanceOf(`REFERRAL_EXPENSE:${cyc.id}`), 0);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM referral_commissions WHERE referrer_id = $1", [r.id])).rows[0].n, 0);
  const after1 = ok(await api("GET", "/v1/me/referrals", { token: r.token }));
  assert.deepEqual([after1.friendsJoined, after1.friendsWhoPlayed, after1.affiliateStatus], [1, 1, null]);
  assert.ok(!JSON.stringify(after1).includes(f.phone.slice(-7)) && !JSON.stringify(after1).includes("Referred Friend"), "invited people are not identified");

  // Paying from the wallet: the PIN is asked for again; the cards are issued at once; a retry never charges twice.
  const { withTx } = await import("../src/db.ts");
  await withTx(pool, (db) => post(db, { kind: "ADJUSTMENT", reference: `test:credit:${r.id}`, memo: "test set-up", debit: accounts.companyBank(), credit: accounts.playerWinnings(r.id), amountKobo: 105_000 }));
  const start = (await wallet(r)).balanceKobo; // ₦1,050
  const walletBuy = (b: object, k = key()) => api("POST", "/v1/orders", { token: r.token, key: k, body: { cycleId: cyc.id, payWith: "WALLET", ...b } });
  fails(await walletBuy({ quantity: 2 }), 403, "PIN_REQUIRED");
  fails(await walletBuy({ quantity: 2, pin: "135790" }), 403, "PIN_REQUIRED");
  fails(await walletBuy({ quantity: 6, pin: r.pin }), 409, "INSUFFICIENT_WALLET"); // ₦1,200 > ₦1,050
  const k = key();
  const paid = ok(await walletBuy({ quantity: 5, pin: r.pin }, k));
  assert.equal(paid.status, "FULFILLED"); assert.equal(paid.ticketIds.length, 5);
  assert.equal(ok(await walletBuy({ quantity: 5, pin: r.pin }, k)).orderId, paid.orderId);
  assert.equal((await wallet(r)).balanceKobo, start - 100_000);
  assert.equal(ok(await api("GET", `/v1/tickets?cycleId=${cyc.id}`, { token: r.token })).tickets.length, 5);
  assert.equal(ok(await api("GET", "/v1/me", { token: r.token })).spending.dailyKobo, 100_000, "wallet purchases count towards spending limits");
  const clearingBefore = await balanceOf("GATEWAY_CLEARING");

  // A wallet purchase cancelled by Compliance goes back to the wallet, not through the payment provider.
  const orderOf = async (userId: string) => (await pool.query("SELECT id FROM orders WHERE user_id = $1 AND cycle_id = $2 AND status = 'FULFILLED' ORDER BY created_at LIMIT 1", [userId, cyc.id])).rows[0].id as string;
  const rq = ok(await api("POST", `/v1/admin/orders/${await orderOf(r.id)}/refund`, { token: ct, body: { reason: "INELIGIBLE_PURCHASE", note: "Bought in error" } }));
  ok(await api("POST", `/v1/admin/refunds/${rq.id}/decision`, { token: fin, body: { approve: true } }));
  assert.equal((await wallet(r)).balanceKobo, start);
  assert.equal(await balanceOf("GATEWAY_CLEARING"), clearingBefore);

  const res = ok(await api("GET", "/v1/admin/finance/cycle-results", { token: fin })).cycles.find((c: any) => c.id === cyc.id);
  assert.equal(res.referral_commissions_kobo, 0); assert.equal(res.affiliate_fees_kobo, 0);
  assert.equal(res.wallet_sales_kobo, 0); // refunded
  assert.equal((await pool.query("SELECT coalesce(sum(amount_kobo), 0)::bigint AS s FROM ledger_entries")).rows[0].s, 0);
});

test("affiliates: a separate application, approved by Compliance; attribution codes; fees only once two people switch them on with the legal approval; settlements by two people", async () => {
  const ct = admins.compliance!.token, ct2 = admins.compliance2!.token, fin = admins.finance!.token, pa = admins.approver!.token;
  const balanceOf = async (code: string) => Number((await pool.query("SELECT coalesce(balance_kobo, 0)::bigint AS b FROM ledger_balances WHERE code = $1", [code])).rows[0]?.b ?? 0);
  const cyc = await openCycle({ total: 60, closeInMs: 3600_000, cap: 25, name: "Affiliate cycle" });
  const app1 = { businessName: "Musa Media", contactEmail: "musa@example.com", channels: "WhatsApp groups and market days in Minna", acceptAgreement: true, trainingCompleted: true };

  // Applying needs the liveness check, a bank account in the applicant's own name, the agreement and the training.
  const a = await newPlayer({ name: "Musa Bello" });
  const before = ok(await api("GET", "/v1/me/affiliate", { token: a.token }));
  assert.equal(before.affiliate, null); assert.equal(before.programme.enabled, false);
  const bankFor = async (p: Player, name: string, n: string) => ok(await api("POST", "/v1/me/bank-accounts", { token: p.token, body: { bankCode: "058", accountNumber: n, accountName: name } })).id as string;
  const wrong = await bankFor(a, "Someone Else", "0200000001");
  fails(await api("POST", "/v1/me/affiliate", { token: a.token, body: { ...app1, bankAccountId: wrong } }), 403, "LIVENESS_REQUIRED");
  ok(await api("POST", "/v1/me/liveness", { token: a.token }));
  fails(await api("POST", "/v1/me/affiliate", { token: a.token, body: { ...app1, bankAccountId: wrong } }), 400, "BANK_ACCOUNT_REQUIRED");
  const bank = await bankFor(a, "Musa Bello", "0200000002");
  fails(await api("POST", "/v1/me/affiliate", { token: a.token, body: { ...app1, bankAccountId: bank, acceptAgreement: false } }), 400, "AGREEMENT_REQUIRED");
  fails(await api("POST", "/v1/me/affiliate", { token: a.token, body: { ...app1, bankAccountId: bank, trainingCompleted: false } }), 400, "TRAINING_REQUIRED");
  const { reference } = ok(await api("POST", "/v1/me/affiliate", { token: a.token, body: { ...app1, bankAccountId: bank } }));
  assert.match(reference, /^AFF-\d{6}$/);
  fails(await api("POST", "/v1/me/affiliate", { token: a.token, body: { ...app1, bankAccountId: bank } }), 409, "ALREADY_APPLIED");
  const applied = ok(await api("GET", "/v1/me/affiliate", { token: a.token })).affiliate;
  assert.deepEqual([applied.status, applied.code, applied.territory], ["APPLIED", null, "NG-NI"]);

  // Compliance decides; nobody else can.
  const list = ok(await api("GET", "/v1/admin/affiliates", { token: ct }));
  const row = list.affiliates.find((x: any) => x.reference === reference);
  assert.equal(row.bank_name_match, true); assert.equal(row.kyc_tier, 2);
  fails(await api("POST", `/v1/admin/affiliates/${row.id}/decision`, { token: fin, body: { decision: "APPROVE" } }), 403, "ROLE_REQUIRED");
  fails(await api("POST", `/v1/admin/affiliates/${row.id}/decision`, { token: ct, body: { decision: "SUSPEND", reason: "x" } }), 409, "INVALID_STATUS");
  const approved = ok(await api("POST", `/v1/admin/affiliates/${row.id}/decision`, { token: ct, body: { decision: "APPROVE" } }));
  assert.match(approved.code, /^[A-HJ-NP-Z2-9]{8}$/);
  await assert.rejects(pool.query("UPDATE affiliates SET attribution_code = 'AAAAAAAA' WHERE id = $1", [row.id]), /cannot be changed/);
  await assert.rejects(pool.query("DELETE FROM affiliates WHERE id = $1", [row.id]), /not allowed/);
  const page = ok(await api("GET", "/v1/me/affiliate", { token: a.token }));
  assert.equal(page.affiliate.code, approved.code); assert.equal(page.affiliate.link, `/r/${approved.code}`);

  // A player signs up with the affiliate's code (typed loosely) and is attributed for good.
  const signUp = async (code: string, name: string) => {
    const seq = ++phoneSeq, phone = "0803" + String(1000000 + seq);
    const otp = ok(await api("POST", "/v1/auth/otp", { body: { phone } }));
    const reg = ok(await api("POST", "/v1/auth/register", { body: { phone, code: otp.devCode, pin: "482915", referralCode: code } }));
    ok(await api("POST", "/v1/me/verify", { token: reg.token, body: { kind: "NIN", number: String(10000000000 + seq), fullName: name, dateOfBirth: "1990-05-17", stateCode: "NG-NI" } }));
    return { token: reg.token, phone, pin: "482915", id: reg.userId } as Player;
  };
  const b = await signUp(` ${approved.code.slice(0, 4).toLowerCase()} ${approved.code.slice(4)} `, "Attributed Buyer");
  assert.equal((await pool.query("SELECT affiliate_id FROM users WHERE id = $1", [b.id])).rows[0].affiliate_id, row.id);
  await assert.rejects(pool.query("UPDATE users SET affiliate_id = NULL WHERE id = $1", [b.id]), /cannot be changed/);

  // Fees are off: the sale is recorded against the affiliate, with a fee of 0 and nothing in the books.
  await buy(b, cyc.id, 5); // ₦1,000
  let fees = (await pool.query("SELECT sales_kobo, rate_bp, amount_kobo FROM affiliate_fees WHERE affiliate_id = $1", [row.id])).rows;
  assert.deepEqual(fees.map((x) => [Number(x.sales_kobo), x.rate_bp, Number(x.amount_kobo)]), [[100_000, 0, 0]]);
  assert.equal(await balanceOf(`AFFILIATE_EXPENSE:${cyc.id}`), 0);

  // Switching fees on: two people, and the legal approval's reference.
  const change = (token: string, body: object) => api("POST", "/v1/admin/affiliate-programme/changes", { token, body: { enable: true, ratePercent: 2.5, reason: "Board approval", ...body } });
  fails(await change(ct, {}), 400, "LEGAL_APPROVAL_REQUIRED");
  fails(await change(ct, { ratePercent: 6, legalReference: "LEGAL/2026/14" }), 400, "INVALID_REQUEST");
  fails(await change(admins.manager!.token, { legalReference: "LEGAL/2026/14" }), 403, "ROLE_REQUIRED");
  const req = ok(await change(ct, { legalReference: "LEGAL/2026/14" }));
  fails(await change(fin, { legalReference: "LEGAL/2026/14" }), 409, "ALREADY_REQUESTED");
  fails(await api("POST", `/v1/admin/affiliate-programme/changes/${req.id}/decision`, { token: ct, body: { approve: true } }), 403, "SAME_PERSON");
  await assert.rejects(pool.query("UPDATE affiliate_programme_changes SET status = 'APPROVED', decided_by = requested_by, decided_at = now() WHERE id = $1", [req.id]), /check/);
  ok(await api("POST", `/v1/admin/affiliate-programme/changes/${req.id}/decision`, { token: fin, body: { approve: true } }));
  assert.deepEqual(ok(await api("GET", "/v1/me/affiliate", { token: a.token })).programme, { enabled: true, ratePercent: 2.5 });

  // Now each purchase earns 2.5%, from the operator's share, owed to the affiliate (not paid into a player wallet).
  await buy(b, cyc.id, 10); // ₦2,000 → ₦50
  assert.equal(await balanceOf(`AFFILIATE_EXPENSE:${cyc.id}`), 5_000);
  assert.equal(await balanceOf(`AFFILIATE_PAYABLE:${row.id}`), -5_000);
  assert.equal(await balanceOf(`PRIZE_EXPENSE:${cyc.id}`), 0);
  assert.equal(ok(await api("GET", "/v1/wallet", { token: a.token })).balanceKobo, 0);
  // No downlines: a player the attributed buyer invites earns the affiliate nothing.
  const bCode = ok(await api("GET", "/v1/me/referrals", { token: b.token })).code;
  const c = await signUp(bCode, "Second Level");
  await buy(c, cyc.id, 4);
  assert.equal(await balanceOf(`AFFILIATE_PAYABLE:${row.id}`), -5_000);
  // Outside the territory nothing is earned.
  await pool.query("UPDATE affiliates SET territory_state = 'NG-KN' WHERE id = $1", [row.id]);
  await buy(b, cyc.id, 1);
  await pool.query("UPDATE affiliates SET territory_state = 'NG-NI' WHERE id = $1", [row.id]);
  assert.equal(await balanceOf(`AFFILIATE_PAYABLE:${row.id}`), -5_000);

  // The affiliate's page: counts and amounts, never who the players are.
  const stats = ok(await api("GET", "/v1/me/affiliate", { token: a.token })).stats;
  assert.deepEqual([stats.signUps, stats.buyers, stats.cards, stats.salesKobo, stats.earnedKobo, stats.pendingKobo, stats.paidKobo], [1, 1, 15, 300_000, 5_000, 5_000, 0]);
  assert.ok(!JSON.stringify(stats).includes("Attributed Buyer"));

  // Settlement: Finance prepares, a payout approver (another person) approves and it is paid to the verified bank account.
  fails(await api("POST", `/v1/admin/affiliates/${row.id}/settlements`, { token: pa }), 403, "ROLE_REQUIRED");
  const st = ok(await api("POST", `/v1/admin/affiliates/${row.id}/settlements`, { token: fin }));
  assert.equal(st.amountKobo, 5_000);
  fails(await api("POST", `/v1/admin/affiliates/${row.id}/settlements`, { token: fin }), 409, "NOTHING_DUE");
  fails(await api("POST", `/v1/admin/affiliate-settlements/${st.id}/decision`, { token: fin, body: { approve: true } }), 403, "ROLE_REQUIRED");
  const paid = ok(await api("POST", `/v1/admin/affiliate-settlements/${st.id}/decision`, { token: pa, body: { approve: true } }));
  assert.equal(paid.status, "PAID"); assert.match(paid.paymentRef, /^SIMAFF-/);
  assert.equal(await balanceOf(`AFFILIATE_PAYABLE:${row.id}`), 0);
  const after = ok(await api("GET", "/v1/me/affiliate", { token: a.token }));
  assert.deepEqual([after.stats.pendingKobo, after.stats.paidKobo, after.statements.length, after.statements[0].status], [0, 5_000, 1, "PAID"]);
  await assert.rejects(pool.query("UPDATE affiliate_fees SET amount_kobo = 1 WHERE affiliate_id = $1", [row.id]), /can only be reversed or settled/);

  // A refunded purchase takes its fee back; already paid, so Compliance is told to recover it.
  const order = (await pool.query("SELECT order_id FROM affiliate_fees WHERE affiliate_id = $1 AND amount_kobo > 0", [row.id])).rows[0].order_id;
  const rq = ok(await api("POST", `/v1/admin/orders/${order}/refund`, { token: ct, body: { reason: "INELIGIBLE_PURCHASE", note: "Test" } }));
  ok(await api("POST", `/v1/admin/refunds/${rq.id}/decision`, { token: fin, body: { approve: true } }));
  assert.equal(await balanceOf(`AFFILIATE_PAYABLE:${row.id}`), 5_000, "the affiliate now owes it");
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM compliance_alerts WHERE kind = 'AFFILIATE_RECOVERY_REQUIRED' AND entity_id = $1", [row.id])).rows[0].n, 1);

  // Suspension: new sign-ups with the code are refused; the history is kept; ending is final.
  ok(await api("POST", `/v1/admin/affiliates/${row.id}/decision`, { token: ct2, body: { decision: "SUSPEND", reason: "Complaint under review" } }));
  const seq = ++phoneSeq, phone = "0803" + String(1000000 + seq);
  const otp = ok(await api("POST", "/v1/auth/otp", { body: { phone } }));
  fails(await api("POST", "/v1/auth/register", { body: { phone, code: otp.devCode, pin: "482915", referralCode: approved.code } }), 400, "INVALID_REFERRAL");
  ok(await api("POST", `/v1/admin/affiliates/${row.id}/decision`, { token: ct, body: { decision: "REINSTATE", reason: "Complaint resolved" } }));
  ok(await api("POST", `/v1/admin/affiliates/${row.id}/decision`, { token: ct, body: { decision: "TERMINATE", reason: "Agreement ended" } }));
  fails(await api("POST", `/v1/admin/affiliates/${row.id}/decision`, { token: ct, body: { decision: "REINSTATE", reason: "x" } }), 409, "INVALID_STATUS");
  assert.deepEqual((await pool.query("SELECT status FROM affiliate_history WHERE affiliate_id = $1 ORDER BY id", [row.id])).rows.map((x) => x.status),
    ["APPLIED", "APPROVED", "SUSPENDED", "APPROVED", "TERMINATED"]);
  assert.ok((await pool.query("SELECT 1 FROM notifications WHERE user_id = $1 AND title = 'Affiliate application approved'", [a.id])).rows.length);

  // Fees back off, for the tests that follow.
  const off = ok(await api("POST", "/v1/admin/affiliate-programme/changes", { token: fin, body: { enable: false, ratePercent: 2.5, reason: "Test reset" } }));
  ok(await api("POST", `/v1/admin/affiliate-programme/changes/${off.id}/decision`, { token: ct, body: { approve: true } }));
  const res = ok(await api("GET", "/v1/admin/finance/cycle-results", { token: fin })).cycles.find((x: any) => x.id === cyc.id);
  assert.equal(res.affiliate_fees_kobo, 0, "the refunded purchase's fee was reversed");
  assert.equal((await pool.query("SELECT coalesce(sum(amount_kobo), 0)::bigint AS s FROM ledger_entries")).rows[0].s, 0);
});

test("affiliate portal: approved materials with versions (two people, never edited), and complaints investigated by Compliance", async () => {
  const ct = admins.compliance!.token, ct2 = admins.compliance2!.token, mt = admins.manager!.token, sup = admins.support!.token;
  // An approved affiliate.
  const a = await newPlayer({ name: "Zara Musa" });
  ok(await api("POST", "/v1/me/liveness", { token: a.token }));
  const bank = ok(await api("POST", "/v1/me/bank-accounts", { token: a.token, body: { bankCode: "058", accountNumber: "0400000001", accountName: "Zara Musa" } })).id;
  ok(await api("POST", "/v1/me/affiliate", { token: a.token, body: { businessName: "Zara Adverts", contactEmail: "zara@example.com", channels: "Radio in Suleja", bankAccountId: bank, acceptAgreement: true, trainingCompleted: true } }));
  const aff = ok(await api("GET", "/v1/admin/affiliates", { token: ct })).affiliates.find((x: any) => x.business_name === "Zara Adverts");
  fails(await api("GET", "/v1/me/affiliate/materials", { token: a.token }), 403, "NOT_AN_AFFILIATE");
  const { code } = ok(await api("POST", `/v1/admin/affiliates/${aff.id}/decision`, { token: ct, body: { decision: "APPROVE" } }));

  // Materials: must say 18+; written by one person, approved by another Compliance officer.
  const text = "Scratch, win, and every card goes into the final draw! {link} 18+ only. Play responsibly.";
  fails(await api("POST", "/v1/admin/materials", { token: mt, body: { name: "WhatsApp invite", channel: "WHATSAPP", bodyEn: "Win big today, guaranteed! {link}" } }), 400, "RESPONSIBLE_PLAY_LINE");
  fails(await api("POST", "/v1/admin/materials", { token: admins.finance!.token, body: { name: "x", channel: "SMS", bodyEn: text } }), 403, "ROLE_REQUIRED");
  fails(await api("POST", "/v1/admin/materials", { token: mt, body: { name: "x", channel: "SMS", bodyEn: text, imageBase64: Buffer.from("<svg/>").toString("base64") } }), 400, "INVALID_IMAGE");
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(100)]);
  const m = ok(await api("POST", "/v1/admin/materials", { token: mt, body: { name: "WhatsApp invite", channel: "WHATSAPP", bodyEn: text, bodyHa: "Karce, ci, kuma kowane kati yana shiga zaɓen ƙarshe! {link} 18+ kawai.", imageBase64: png.toString("base64") } }));
  assert.deepEqual(ok(await api("GET", "/v1/me/affiliate/materials", { token: a.token })).materials, [], "nothing until approved");
  assert.equal((await app.inject({ method: "GET", url: `/v1/material-images/${m.versionId}` })).statusCode, 404, "an unapproved picture is not public");
  fails(await api("POST", `/v1/admin/material-versions/${m.versionId}/decision`, { token: mt, body: { approve: true } }), 403, "ROLE_REQUIRED");
  ok(await api("POST", `/v1/admin/material-versions/${m.versionId}/decision`, { token: ct, body: { approve: true } }));
  const own = ok(await api("POST", "/v1/admin/materials", { token: ct, body: { name: "SMS", channel: "SMS", bodyEn: text } }));
  fails(await api("POST", `/v1/admin/material-versions/${own.versionId}/decision`, { token: ct, body: { approve: true } }), 403, "SAME_PERSON");
  let mine = ok(await api("GET", "/v1/me/affiliate/materials", { token: a.token }));
  assert.equal(mine.link, `/r/${code}`); assert.equal(mine.materials.length, 1); assert.equal(mine.materials[0].version, 1);
  const img = await app.inject({ method: "GET", url: `/v1/material-images/${m.versionId}` });
  assert.equal(img.statusCode, 200); assert.equal(img.headers["content-type"], "image/png");
  await assert.rejects(pool.query("UPDATE marketing_material_versions SET body_en = 'Edited 18+' WHERE id = $1", [m.versionId]), /cannot be edited/);
  await assert.rejects(pool.query("DELETE FROM marketing_material_versions WHERE id = $1", [m.versionId]), /append-only/);

  // A correction is a new version: the old one stays in use until it is approved, then it is retired.
  const v2 = ok(await api("POST", `/v1/admin/materials/${m.id}/versions`, { token: mt, body: { bodyEn: "Every card goes into the final draw. {link} 18+ only. Play responsibly." } }));
  assert.equal(v2.version, 2);
  fails(await api("POST", `/v1/admin/materials/${m.id}/versions`, { token: mt, body: { bodyEn: "Another one. 18+ only." } }), 409, "VERSION_PENDING");
  assert.equal(ok(await api("GET", "/v1/me/affiliate/materials", { token: a.token })).materials[0].version, 1);
  ok(await api("POST", `/v1/admin/material-versions/${v2.versionId}/decision`, { token: ct2, body: { approve: true } }));
  mine = ok(await api("GET", "/v1/me/affiliate/materials", { token: a.token }));
  assert.deepEqual(mine.materials.map((x: any) => x.version), [2]);
  const versions = ok(await api("GET", "/v1/admin/materials", { token: admins.auditor!.token })).materials.find((x: any) => x.id === m.id).versions;
  assert.deepEqual(versions.map((x: any) => [x.version, x.status]), [[2, "APPROVED"], [1, "RETIRED"]]);
  ok(await api("POST", `/v1/admin/materials/${m.id}/retire`, { token: ct }));
  assert.deepEqual(ok(await api("GET", "/v1/me/affiliate/materials", { token: a.token })).materials, []);

  // Complaints: a player reports a promoter (code typed loosely); Compliance investigates and concludes.
  const p = await newPlayer();
  fails(await api("POST", "/v1/affiliate-reports", { token: p.token, body: { category: "BRIBES", description: "x" } }), 400, "INVALID_REQUEST");
  const rep = ok(await api("POST", "/v1/affiliate-reports", { token: p.token, body: { code: code.toLowerCase(), category: "MISLEADING", description: "Told me I would surely win the car." } }));
  assert.match(rep.reference, /^CMP-\d{6}$/);
  const unknown = ok(await api("POST", "/v1/affiliate-reports", { token: p.token, body: { category: "PAID_SIGNUPS", description: "Someone paid ₦200 for each sign-up at the market." } }));
  fails(await api("GET", "/v1/admin/affiliate-complaints", { token: sup }), 403, "ROLE_REQUIRED");
  const list = ok(await api("GET", "/v1/admin/affiliate-complaints", { token: ct })).complaints;
  const c1 = list.find((x: any) => x.reference === rep.reference), c2 = list.find((x: any) => x.reference === unknown.reference);
  assert.equal(c1.affiliate_id, aff.id); assert.equal(c2.affiliate_id, null);
  fails(await api("POST", `/v1/admin/affiliate-complaints/${c1.id}/conclude`, { token: ct, body: { upheld: true, findings: "x", outcome: "WARNING" } }), 409, "NOT_INVESTIGATING");
  ok(await api("POST", `/v1/admin/affiliate-complaints/${c1.id}/investigate`, { token: ct, body: {} }));
  fails(await api("POST", `/v1/admin/affiliate-complaints/${c1.id}/conclude`, { token: ct2, body: { upheld: true, findings: "x", outcome: "WARNING" } }), 403, "NOT_INVESTIGATOR");
  fails(await api("POST", `/v1/admin/affiliate-complaints/${c1.id}/conclude`, { token: ct, body: { upheld: false, findings: "x", outcome: "WARNING" } }), 400, "INVALID_OUTCOME");
  ok(await api("POST", `/v1/admin/affiliate-complaints/${c1.id}/conclude`, { token: ct, body: { upheld: true, findings: "Admitted promising a win.", outcome: "WARNING" } }));
  assert.ok((await pool.query("SELECT 1 FROM notifications WHERE user_id = $1 AND title = 'Formal warning'", [a.id])).rows.length);
  assert.ok((await pool.query("SELECT 1 FROM notifications WHERE user_id = $1 AND title = 'Your report has been looked into'", [p.id])).rows.length);
  await assert.rejects(pool.query("UPDATE affiliate_complaints SET outcome = 'NO_ACTION' WHERE id = $1", [c1.id]), /final/);

  // The second report: linked to the affiliate during the investigation; upheld; the affiliate is suspended in the same step.
  ok(await api("POST", `/v1/admin/affiliate-complaints/${c2.id}/investigate`, { token: ct2, body: { affiliateId: aff.id } }));
  ok(await api("POST", `/v1/admin/affiliate-complaints/${c2.id}/conclude`, { token: ct2, body: { upheld: true, findings: "Paid for sign-ups at Suleja market.", outcome: "SUSPENDED" } }));
  assert.equal(ok(await api("GET", "/v1/me/affiliate", { token: a.token })).affiliate.status, "SUSPENDED");
  fails(await api("GET", "/v1/me/affiliate/materials", { token: a.token }), 403, "NOT_AN_AFFILIATE");

  // Staff can record a complaint, but not investigate their own.
  const sc = ok(await api("POST", "/v1/admin/affiliate-complaints", { token: ct, body: { affiliateId: aff.id, category: "UNDERAGE", description: "Seen handing leaflets at a secondary school." } }));
  fails(await api("POST", `/v1/admin/affiliate-complaints/${sc.id}/investigate`, { token: ct, body: {} }), 403, "SAME_PERSON");
  ok(await api("POST", `/v1/admin/affiliate-complaints/${sc.id}/investigate`, { token: ct2, body: {} }));
  ok(await api("POST", `/v1/admin/affiliate-complaints/${sc.id}/conclude`, { token: ct2, body: { upheld: true, findings: "Confirmed by the school.", outcome: "TERMINATED" } }));
  assert.equal(ok(await api("GET", "/v1/me/affiliate", { token: a.token })).affiliate.status, "TERMINATED");
  assert.deepEqual((await pool.query("SELECT status FROM affiliate_history WHERE affiliate_id = $1 ORDER BY id", [aff.id])).rows.map((x) => x.status),
    ["APPLIED", "APPROVED", "WARNED", "SUSPENDED", "TERMINATED"]);
});

test("stockist portal: centres approved by two people, vouchers verified and redeemed once with ID and photo, fees invoiced, stock moves recorded, reconciliation", async () => {
  const ft = admins.fulfilment!.token, ct = admins.compliance!.token, fin = admins.finance!.token, sec = admins.security!.token, sec2 = admins.security2!.token;
  const balanceOf = async (code: string) => Number((await pool.query("SELECT coalesce(balance_kobo, 0)::bigint AS b FROM ledger_balances WHERE code = $1", [code])).rows[0]?.b ?? 0);
  const reg = (b: object) => api("POST", "/v1/admin/stockists", { token: ft, body: { name: "Bida Sub Stockist", tier: "SUB", stateCode: "NG-NI", area: "Bida",
    address: "12 Market Road, Bida", phone: "08030002222", coverage: ["Bida", "Katcha"], feeKobo: 100_000, ...b } });

  // STK-001/002: registered by Fulfilment with coverage; approved by Compliance (not the same person).
  const mega = await centre();
  fails(await reg({}), 400, "INVALID_TIER"); // a Sub Stockist needs its Mega Stockist
  fails(await api("POST", "/v1/admin/stockists", { token: ct, body: { name: "X", tier: "MEGA", stateCode: "NG-NI", area: "Minna", address: "Somewhere 1", phone: "1", coverage: ["A"], feeKobo: 0 } }), 403, "ROLE_REQUIRED");
  const sub = ok(await reg({ parentId: mega }));
  assert.match(sub.code, /^STK-\d{4}$/);
  assert.ok(!ok(await api("GET", "/v1/stockists?state=NG-NI")).centres.some((c: any) => c.id === sub.id), "not listed until approved");
  fails(await api("POST", `/v1/admin/stockists/${sub.id}/decision`, { token: ft, body: { decision: "APPROVE" } }), 403, "ROLE_REQUIRED");
  ok(await api("POST", `/v1/admin/stockists/${sub.id}/decision`, { token: ct, body: { decision: "APPROVE" } }));
  const listed = ok(await api("GET", "/v1/stockists?state=NG-NI")).centres.find((c: any) => c.id === sub.id);
  assert.deepEqual(listed.coverage, ["Bida", "Katcha"]); assert.equal(listed.fee_kobo, undefined, "fees are not public");

  // STK-009: a fee change needs someone in Finance.
  ok(await api("POST", `/v1/admin/stockists/${sub.id}/fee`, { token: ft, body: { feeKobo: 150_000 } }));
  fails(await api("POST", `/v1/admin/stockists/${sub.id}/fee`, { token: ft, body: { feeKobo: 1 } }), 409, "FEE_CHANGE_PENDING");
  assert.equal(ok(await api("POST", `/v1/admin/stockists/${sub.id}/fee/decision`, { token: fin, body: { approve: true } })).feeKobo, 150_000);

  // A centre's staff account: linked to the centre at creation; the role is granted by two security administrators and held alone.
  const nobody = ok(await api("POST", "/v1/admin/staff", { token: sec, body: { email: "loose@example.test", fullName: "Not At A Centre" } }));
  const r0 = ok(await api("POST", "/v1/admin/staff/requests", { token: sec, body: { adminUserId: nobody.id, action: "GRANT_ROLE", role: "STOCKIST", reason: "x" } }));
  fails(await api("POST", `/v1/admin/staff/requests/${r0.id}/decision`, { token: sec2, body: { approve: true } }), 409, "RULE_VIOLATION");
  const clerk = ok(await api("POST", "/v1/admin/staff", { token: sec, body: { email: "clerk@bida.example.test", fullName: "Bida Clerk", stockistId: sub.id } }));
  const r1 = ok(await api("POST", "/v1/admin/staff/requests", { token: sec, body: { adminUserId: clerk.id, action: "GRANT_ROLE", role: "STOCKIST", reason: "Bida centre clerk" } }));
  ok(await api("POST", `/v1/admin/staff/requests/${r1.id}/decision`, { token: sec2, body: { approve: true } }));
  fails(await api("POST", "/v1/admin/staff/requests", { token: sec, body: { adminUserId: clerk.id, action: "GRANT_ROLE", role: "FULFILMENT", reason: "x" } }), 409, "ROLE_CONFLICT");
  const st = ok(await api("POST", "/v1/admin/dev-login", { body: { email: "clerk@bida.example.test" } })).token;
  assert.equal(ok(await api("GET", "/v1/admin/me", { token: st })).stockistId, sub.id);
  for (const path of ["/v1/admin/dashboard", "/v1/admin/cycles", "/v1/admin/fulfilment", "/v1/admin/stockists", "/v1/admin/auditors"]) {
    fails(await api("GET", path, { token: st }), 403, "ROLE_REQUIRED");
  }
  let dash = ok(await api("GET", "/v1/admin/stockist-portal", { token: st }));
  assert.equal(dash.centre.name, "Bida Sub Stockist"); assert.equal(dash.stats.assigned, 0);
  fails(await api("GET", "/v1/admin/stockist-portal", { token: ft }), 403, "ROLE_REQUIRED");

  // A merchandise winner.
  const rice = ok(await api("POST", "/v1/admin/skus", { token: ft, body: { name: "Rice 50kg", advertisedValueKobo: 7_500_000, serialised: true } })).id;
  ok(await api("POST", "/v1/admin/stock/receive", { token: ft, body: { skuId: rice, supplierId, warehouseId, poReference: "PO-RICE", serialNumbers: ["RICE-1", "RICE-2", "RICE-3"], acquisitionCostKobo: 1, landedCostKobo: 1 } }));
  const policy = config.policy!;
  config.policy = { ...POLICY, prizeShareBp: 10_000, instantShareBp: 0 };
  const cyc = await openCycle({ total: 400, closeInMs: 2500, cap: 400, name: "Rice draw", priceKobo: 50_000, escrowKobo: 0,
    tiers: [{ stage: "FINAL_DRAW", kind: "MERCHANDISE", title: "Rice 50kg", skuId: rice, quantity: 2, drawOrder: 1 }] });
  config.policy = policy;
  const w = await newPlayer({ name: "Aisha Bello" });
  await buy(w, cyc.id, 3);
  ok(await api("PUT", "/v1/me/next-of-kin", { token: w.token, body: { fullName: "Kin Person", relationship: "Sister", phone: "08030009999" } }));
  await sleep(Math.max(0, cyc.closeAt - Date.now()) + 2200);
  await closeDueCycles(ctx);
  for (const a of ["manager", "finance", "auditor"]) ok(await api("POST", `/v1/admin/cycles/${cyc.id}/draw/sign`, { token: admins[a]!.token }));
  ok(await api("POST", `/v1/admin/cycles/${cyc.id}/draw/execute`, { token: admins.manager!.token }));
  const claims = ok(await api("GET", "/v1/claims", { token: w.token })).claims.filter((c: any) => c.title === "Rice 50kg");
  assert.equal(claims.length, 2);
  const [c1, c2] = claims;

  // STK-003: stock sent to a centre ahead of claims, with a recorded move; the database refuses a move without one.
  const third = (await pool.query("SELECT u.id FROM stock_units u WHERE u.sku_id = $1 AND NOT EXISTS (SELECT 1 FROM prize_claims pc WHERE pc.stock_unit_id = u.id) LIMIT 1", [rice])).rows[0].id;
  await assert.rejects(pool.query("UPDATE stock_units SET stockist_id = $2 WHERE id = $1", [third, sub.id]), /recorded stock movement/);

  // The winner collects at the centre: dispatch moves the unit there and issues a voucher.
  ok(await api("POST", `/v1/claims/${c1.id}/redeem`, { token: w.token, body: { method: "COLLECTION", stockistId: sub.id, pin: w.pin } }));
  ok(await api("POST", `/v1/claims/${c2.id}/redeem`, { token: w.token, body: { method: "COLLECTION", stockistId: sub.id, pin: w.pin } }));
  ok(await api("POST", `/v1/admin/fulfilment/${c1.id}/dispatch`, { token: ft, body: {} }));
  ok(await api("POST", `/v1/admin/fulfilment/${c2.id}/dispatch`, { token: ft, body: {} }));
  const mine = ok(await api("GET", "/v1/claims", { token: w.token })).claims;
  const v1 = mine.find((x: any) => x.id === c1.id), v2 = mine.find((x: any) => x.id === c2.id);
  assert.match(v1.voucher_ref, /^WV-[A-Z2-9]{4}-[A-Z2-9]{4}$/); assert.equal(v1.centre_name, "Bida Sub Stockist"); assert.match(v1.handoverCode, /^\d{6}$/);
  const moves = (await pool.query("SELECT m.from_stockist, m.to_stockist FROM stock_movements m JOIN prize_claims pc ON pc.stock_unit_id = m.stock_unit_id WHERE pc.id = $1", [c1.id])).rows;
  assert.deepEqual(moves, [{ from_stockist: null, to_stockist: sub.id }]);

  // STK-005: verifying a voucher; another centre's staff cannot see it.
  dash = ok(await api("GET", "/v1/admin/stockist-portal", { token: st }));
  assert.deepEqual([dash.stats.assigned, dash.stats.waiting, dash.pending.length], [2, 2, 2]);
  fails(await api("POST", "/v1/admin/stockist-portal/verify", { token: st, body: { voucherRef: "WV-AAAA-AAAA" } }), 404, "NOT_FOUND");
  const check = ok(await api("POST", "/v1/admin/stockist-portal/verify", { token: st, body: { voucherRef: v1.voucher_ref.toLowerCase() } }));
  assert.deepEqual([check.prize, check.winnerName, check.winnerPhoneLast4], ["Rice 50kg", "Aisha Bello", w.phone.slice(-4)]);
  assert.ok(!JSON.stringify(check).match(/\b\d{6}\b/), "the handover code is never shown to the centre");

  // STK-007: handover needs the ID check, a real photo and the winner's code.
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(200)]);
  const hand = (b: object) => api("POST", `/v1/admin/stockist-portal/handover/${c1.id}`, { token: st, body: { code: v1.handoverCode, ...b } });
  fails(await hand({ photoBase64: png.toString("base64") }), 400, "ID_CHECK_REQUIRED");
  fails(await hand({ idChecked: "NIN_SLIP", photoRef: "p.jpg" }), 400, "PHOTO_REQUIRED");
  fails(await hand({ idChecked: "NIN_SLIP", photoBase64: Buffer.from("not a photo").toString("base64") }), 400, "INVALID_IMAGE");
  assert.equal(ok(await hand({ idChecked: "NIN_SLIP", photoBase64: png.toString("base64") })).status, "DELIVERED");
  // STK-006: never twice.
  fails(await api("POST", "/v1/admin/stockist-portal/verify", { token: st, body: { voucherRef: v1.voucher_ref } }), 409, "ALREADY_REDEEMED");
  fails(await hand({ idChecked: "NIN_SLIP", photoBase64: png.toString("base64") }), 409, "NOT_IN_TRANSIT");
  const proof = await app.inject({ method: "GET", url: `/v1/admin/fulfilment/${c1.id}/proof`, headers: { authorization: `Bearer ${admins.auditor!.token}` } });
  assert.equal(proof.statusCode, 200); assert.deepEqual(proof.rawPayload, png);
  assert.equal((await pool.query("SELECT id_checked FROM shipments WHERE prize_claim_id = $1", [c1.id])).rows[0].id_checked, "NIN_SLIP");

  // STK-010: a damaged unit cannot be handed over until Fulfilment resolves the report.
  const unit2 = (await pool.query("SELECT stock_unit_id FROM prize_claims WHERE id = $1", [c2.id])).rows[0].stock_unit_id;
  ok(await api("POST", "/v1/admin/stockist-portal/incidents", { token: st, body: { unitId: unit2, kind: "DAMAGED", description: "Bag torn, rice spilled." } }));
  fails(await api("POST", "/v1/admin/stockist-portal/incidents", { token: st, body: { unitId: unit2, kind: "OTHER", description: "Again please" } }), 409, "INCIDENT_OPEN");
  fails(await api("POST", `/v1/admin/stockist-portal/handover/${c2.id}`, { token: st, body: { code: v2.handoverCode, idChecked: "VOTERS_CARD", photoBase64: png.toString("base64") } }), 409, "INCIDENT_OPEN");
  const inc = ok(await api("GET", "/v1/admin/stock/incidents", { token: ft })).incidents.find((i: any) => i.status === "OPEN" && i.serial_number);
  ok(await api("POST", `/v1/admin/stock/incidents/${inc.id}/resolve`, { token: ft, body: { resolution: "Rebagged; weight checked at 50kg." } }));
  assert.equal(ok(await api("POST", `/v1/admin/stockist-portal/handover/${c2.id}`, { token: st, body: { code: v2.handoverCode, idChecked: "VOTERS_CARD", photoBase64: png.toString("base64") } })).status, "DELIVERED");

  // STK-009/011: two handovers at ₦1,500 each; the centre invoices, Finance pays.
  assert.equal(await balanceOf(`STOCKIST_PAYABLE:${sub.id}`), -300_000);
  assert.equal(await balanceOf(`FULFILMENT_EXPENSE:${cyc.id}`), 300_000);
  const invoice = ok(await api("POST", "/v1/admin/stockist-portal/invoices", { token: st, body: { theirReference: "BIDA/2027/001" } }));
  assert.equal(invoice.amountKobo, 300_000);
  fails(await api("POST", "/v1/admin/stockist-portal/invoices", { token: st, body: {} }), 409, "NOTHING_DUE");
  const inv = ok(await api("GET", "/v1/admin/stockist-invoices", { token: fin })).invoices.find((i: any) => i.reference === invoice.reference);
  fails(await api("POST", `/v1/admin/stockist-invoices/${inv.id}/decision`, { token: ft, body: { approve: true } }), 403, "ROLE_REQUIRED");
  assert.match(ok(await api("POST", `/v1/admin/stockist-invoices/${inv.id}/decision`, { token: fin, body: { approve: true } })).paymentRef, /^SIMSTK-/);
  assert.equal(await balanceOf(`STOCKIST_PAYABLE:${sub.id}`), 0);
  dash = ok(await api("GET", "/v1/admin/stockist-portal", { token: st }));
  assert.deepEqual([dash.stats.fulfilled, dash.stats.outstanding, dash.stats.fulfilmentRate, dash.fees.paidKobo], [2, 0, 100, 300_000]);

  // STK-008/012: reconciliation adds up; outstanding obligations are reported.
  const rec = ok(await api("GET", "/v1/admin/reports/stockist-reconciliation", { token: admins.auditor!.token }));
  const row = rec.centres.find((c: any) => c.id === sub.id);
  assert.deepEqual([row.handed_over, row.awaiting_collection, row.mismatches], [2, 0, 0]);
  assert.equal(rec.totalMismatches, 0);
  const out = ok(await api("GET", "/v1/admin/reports/outstanding-prizes", { token: fin }));
  assert.ok(Array.isArray(out.byStatus) && Array.isArray(out.byCentre));

  // Suspending a centre takes it off the locator; claims can no longer choose it.
  ok(await api("POST", `/v1/admin/stockists/${sub.id}/decision`, { token: ct, body: { decision: "SUSPEND", reason: "Audit visit" } }));
  assert.ok(!ok(await api("GET", "/v1/stockists")).centres.some((c: any) => c.id === sub.id));
  ok(await api("POST", "/v1/admin/stock/allocate", { token: ft, body: { unitIds: [third], toStockistId: mega, reason: "Pre-position for collections" } }));
  fails(await api("POST", "/v1/admin/stock/allocate", { token: ft, body: { unitIds: [third], toStockistId: sub.id, reason: "x" } }), 400, "INVALID_STOCKIST");
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM stock_movements WHERE stock_unit_id = $1", [third])).rows[0].n, 1);
  await assert.rejects(pool.query("DELETE FROM stock_movements WHERE stock_unit_id = $1", [third]), /not allowed|append-only|cannot/);
  assert.equal((await pool.query("SELECT coalesce(sum(amount_kobo), 0)::bigint AS s FROM ledger_entries")).rows[0].s, 0);
});

test("statutory deductions on winnings: the rate is fixed on the campaign and published; every cash award records gross, deduction and net", async () => {
  const fin = admins.finance!.token;
  const balanceOf = async (code: string) => Number((await pool.query("SELECT coalesce(balance_kobo, 0)::bigint AS b FROM ledger_balances WHERE code = $1", [code])).rows[0]?.b ?? 0);
  const policy = config.policy!;
  config.policy = { ...POLICY, prizeShareBp: 10_000, instantShareBp: 10_000, winningsTaxBp: 1000 }; // every card wins ₦500; 10% withheld
  const cyc = await openCycle({ total: 4, closeInMs: 3600_000, cap: 4, name: "Deduction check", priceKobo: 50_000, escrowKobo: 200_000, tiers: [
    { stage: "INSTANT", kind: "CASH", title: "₦500", cashKobo: 50_000, quantity: 4 }] });
  config.policy = policy;
  await assert.rejects(pool.query("UPDATE cycles SET winnings_tax_bp = 0 WHERE id = $1", [cyc.id]), /fixed once a cycle is approved/);
  assert.equal(ok(await api("GET", `/v1/cycles/${cyc.id}/rules`)).winningsTaxPercent, 10);
  assert.equal(ok(await api("GET", `/v1/cycles/${cyc.id}`)).winnings_tax_bp, 1000);

  const p = await newPlayer();
  await buy(p, cyc.id, 2);
  const [t] = ok(await api("GET", `/v1/tickets?cycleId=${cyc.id}`, { token: p.token })).tickets;
  ok(await api("POST", `/v1/tickets/${t.id}/reveal`, { token: p.token }));
  ok(await api("POST", `/v1/tickets/${t.id}/accept`, { token: p.token }));
  assert.equal(ok(await api("GET", "/v1/wallet", { token: p.token })).balanceKobo, 45_000, "₦500 won, ₦50 withheld");
  assert.equal(await balanceOf(`PRIZE_EXPENSE:${cyc.id}`), 50_000, "the prize cost is the full prize");
  assert.equal(await balanceOf("STATUTORY_DEDUCTIONS_PAYABLE") <= -5_000, true);
  const d = (await pool.query("SELECT gross_kobo, rate_bp, deduction_kobo, net_kobo, status FROM prize_deductions WHERE ticket_id = $1", [t.id])).rows[0];
  assert.deepEqual([Number(d.gross_kobo), d.rate_bp, Number(d.deduction_kobo), Number(d.net_kobo), d.status], [50_000, 1000, 5_000, 45_000, "DEDUCTED"]);
  await assert.rejects(pool.query("UPDATE prize_deductions SET deduction_kobo = 0 WHERE ticket_id = $1", [t.id]), /can only be reversed/);
  await assert.rejects(pool.query("DELETE FROM prize_deductions WHERE ticket_id = $1", [t.id]), /append-only/);

  // The daily report; and the results count the deduction as part of the prize cost.
  const today = new Date(Date.now() + 3600_000).toISOString().slice(0, 10);
  fails(await api("GET", `/v1/admin/reports/deductions?from=${today}&to=${today}`, { token: admins.manager!.token }), 403, "ROLE_REQUIRED");
  const rep = ok(await api("GET", `/v1/admin/reports/deductions?from=2026-01-01&to=2099-12-31`, { token: fin }));
  const day = rep.days.find((x: any) => x.cycle === "Deduction check");
  assert.deepEqual([day.awards, day.gross_kobo, day.deduction_kobo, day.net_kobo, day.rate_bp], [1, 50_000, 5_000, 45_000, 1000]);
  assert.ok(rep.heldForAuthorityKobo >= 5_000);
  assert.match(rep.warning ?? "", /0%/, "other campaigns still have no rate");
  const res = ok(await api("GET", "/v1/admin/finance/cycle-results", { token: fin })).cycles.find((x: any) => x.id === cyc.id);
  assert.deepEqual([res.instant_prizes_kobo, res.statutory_deductions_kobo], [45_000, 5_000]);
  assert.ok(ok(await api("GET", "/v1/admin/dashboard", { token: fin })).totals.deductions_held_kobo >= 5_000);

  // A forfeited prize gives back both parts.
  const order = (await pool.query("SELECT order_id FROM tickets WHERE id = $1", [t.id])).rows[0].order_id;
  const rq = ok(await api("POST", `/v1/admin/orders/${order}/refund`, { token: admins.compliance!.token, body: { reason: "INELIGIBLE_PURCHASE", note: "Test" } }));
  ok(await api("POST", `/v1/admin/refunds/${rq.id}/decision`, { token: fin, body: { approve: true } }));
  assert.equal((await pool.query("SELECT status FROM prize_deductions WHERE ticket_id = $1", [t.id])).rows[0].status, "REVERSED");
  assert.equal(await balanceOf(`PRIZE_EXPENSE:${cyc.id}`), 0);
  assert.equal((await pool.query("SELECT coalesce(sum(amount_kobo), 0)::bigint AS s FROM ledger_entries")).rows[0].s, 0);
});

test("pop-ups, prize pictures and live activity: two people for any announcement, pictures checked and locked once sales open, real activity only", async () => {
  const mt = admins.manager!.token, ct = admins.compliance!.token, ct2 = admins.compliance2!.token;
  const now = Date.now();
  const flash = (token: string, b: object) => api("POST", "/v1/admin/flash", { token, body: { titleEn: "Halfway there!", bodyEn: "Half of the cards are sold.", startsAt: new Date(now - 1000).toISOString(), endsAt: new Date(now + 3600_000).toISOString(), ...b } });
  fails(await flash(admins.finance!.token, {}), 403, "ROLE_REQUIRED");
  fails(await flash(mt, { link: "https://evil.example" }), 400, "INVALID_REQUEST");
  const f = ok(await flash(mt, { titleHa: "Mun kai rabi!", bodyHa: "An sayar da rabin katunan.", link: "#/buy" }));
  assert.deepEqual(ok(await api("GET", "/v1/flash")).messages, []); // nothing shows until approved
  fails(await api("POST", `/v1/admin/flash/${f.id}/decision`, { token: mt, body: { approve: true } }), 403, "ROLE_REQUIRED");
  const own = ok(await flash(ct, {}));
  fails(await api("POST", `/v1/admin/flash/${own.id}/decision`, { token: ct, body: { approve: true } }), 403, "SAME_PERSON");
  assert.equal(ok(await api("POST", `/v1/admin/flash/${f.id}/decision`, { token: ct, body: { approve: true } })).status, "APPROVED");
  const live = ok(await api("GET", "/v1/flash")).messages;
  assert.equal(live.length, 1); assert.equal(live[0].title_ha, "Mun kai rabi!"); assert.equal(live[0].link, "#/buy");
  await assert.rejects(pool.query("UPDATE flash_messages SET body_en = 'Edited' WHERE id = $1", [f.id]), /cannot be edited/);
  await assert.rejects(pool.query("UPDATE flash_messages SET status = 'APPROVED', decided_by = created_by WHERE id = $1", [own.id]), /flash_messages_check/);
  ok(await api("POST", `/v1/admin/flash/${f.id}/withdraw`, { token: ct2 }));
  assert.deepEqual(ok(await api("GET", "/v1/flash")).messages, []);

  // Prize pictures: real image files only, at most 1 MB; fixed once sales open.
  const draft = ok(await api("POST", "/v1/admin/cycles", { token: mt, body: { name: "Pictures", ticketPriceKobo: N200, totalTickets: 100, maxTicketsPerAccount: 10,
    salesOpenAt: new Date(now - 1000).toISOString(), salesCloseAt: new Date(now + 3600_000).toISOString(), drawAt: new Date(now + 3600_000).toISOString() } })).id;
  const tier = ok(await api("POST", `/v1/admin/cycles/${draft}/prize-tiers`, { token: mt, body: { stage: "FINAL_DRAW", kind: "CASH", title: "₦4,000 cash", cashKobo: 400_000, quantity: 1, drawOrder: 1 } })).id;
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(200)]);
  const put = (token: string, data: Buffer) => api("PUT", `/v1/admin/prize-tiers/${tier}/image`, { token, body: { dataBase64: data.toString("base64") } });
  fails(await put(admins.fulfilment!.token, png), 403, "ROLE_REQUIRED");
  fails(await put(mt, Buffer.from("<svg onload=alert(1)></svg>")), 400, "INVALID_IMAGE");
  fails(await put(mt, Buffer.concat([png, Buffer.alloc(1024 * 1024)])), 400, "INVALID_IMAGE");
  assert.equal(ok(await put(mt, png)).contentType, "image/png");
  const img = await app.inject({ method: "GET", url: `/v1/prize-images/${tier}` });
  assert.equal(img.statusCode, 200); assert.equal(img.headers["content-type"], "image/png"); assert.equal(img.headers["x-content-type-options"], "nosniff");
  assert.deepEqual(img.rawPayload, png);
  assert.equal((await app.inject({ method: "GET", url: `/v1/prize-images/${tier}`, headers: { "if-none-match": String(img.headers.etag) } })).statusCode, 304);
  // A cycle that is already selling: its pictures cannot change.
  const sellingTier = (await pool.query("SELECT id FROM prize_tiers WHERE cycle_id = (SELECT id FROM cycles WHERE name = 'Referral cycle') LIMIT 1")).rows[0].id;
  fails(await api("PUT", `/v1/admin/prize-tiers/${sellingTier}/image`, { token: mt, body: { dataBase64: png.toString("base64") } }), 409, "RULE_VIOLATION");
  const pub = ok(await api("GET", `/v1/cycles/${(await pool.query("SELECT id FROM cycles WHERE name = 'Referral cycle'")).rows[0].id}`));
  assert.ok(pub.prizes.every((p: any) => typeof p.has_image === "boolean" && p.id));

  // Activity: real figures, and nothing about who won.
  const act = ok(await api("GET", `/v1/cycles/${cycleA.id}/activity`));
  assert.equal(typeof act.soldLastHour, "number");
  assert.ok(act.recentWins.every((w: any) => Object.keys(w).sort().join() === "at,cashKobo"));
});

test("accepting instant prizes: the player taps Accept to move a prize into the wallet, once; prizes left waiting are accepted for them when the season closes", async () => {
  const { revealClosedCycles } = await import("../src/modules/tickets.ts");
  const policy = config.policy!;
  config.policy = { ...POLICY, prizeShareBp: 10_000, instantShareBp: 9_100 }; // 10 of 11 cards win, so wins are certain
  const ft = admins.fulfilment!.token;
  const ring = ok(await api("POST", "/v1/admin/skus", { token: ft, body: { name: "Key ring B", advertisedValueKobo: 10_000, serialised: true } })).id;
  ok(await api("POST", "/v1/admin/stock/receive", { token: ft, body: { skuId: ring, supplierId, warehouseId, poReference: "PO-ACC", serialNumbers: ["SN-ACC-1", "SN-ACC-2"], acquisitionCostKobo: 5_000, landedCostKobo: 6_000 } }));
  const cyc = await openCycle({ total: 11, closeInMs: 3000, cap: 11, name: "Accept check", priceKobo: 50_000, escrowKobo: 500_000, tiers: [
    { stage: "INSTANT", kind: "CASH", title: "₦500", cashKobo: 50_000, quantity: 10 },
    { stage: "FINAL_DRAW", kind: "MERCHANDISE", title: "Key ring B", skuId: ring, quantity: 2, drawOrder: 1 }] });
  config.policy = policy;
  const p = await newPlayer(), other = await newPlayer();
  await buy(p, cyc.id, 4);
  const mine = ok(await api("GET", `/v1/tickets?cycleId=${cyc.id}`, { token: p.token })).tickets;
  const results = [];
  for (const t of mine.slice(0, 3)) results.push(ok(await api("POST", `/v1/tickets/${t.id}/reveal`, { token: p.token })).ticket);
  const win = results.find((t) => t.result.cashKobo)!, lose = results.find((t) => !t.result.cashKobo);
  const wallet = async () => ok(await api("GET", "/v1/wallet", { token: p.token })).balanceKobo;
  assert.equal(await wallet(), 0, "revealing does not pay");

  fails(await api("POST", `/v1/tickets/${win.id}/accept`, { token: other.token }), 404, "NOT_FOUND");
  if (lose) fails(await api("POST", `/v1/tickets/${lose.id}/accept`, { token: p.token }), 409, "NO_PRIZE");
  fails(await api("POST", `/v1/tickets/${mine[3].id}/accept`, { token: p.token }), 409, "NO_PRIZE"); // not scratched yet
  const twice = await Promise.all([1, 2, 3].map(() => api("POST", `/v1/tickets/${win.id}/accept`, { token: p.token })));
  assert.equal(twice.reduce((s, r) => s + ok(r).acceptedKobo, 0), 50_000, "accepted once, however often it is tapped");
  assert.ok(ok(twice[0]!).ticket.result.acceptedAt);
  assert.equal(await wallet(), 50_000);
  await assert.rejects(pool.query("UPDATE tickets SET prize_accepted_at = NULL WHERE id = $1", [win.id]), /cannot be accepted again or altered/);
  if (lose) await assert.rejects(pool.query("UPDATE tickets SET prize_accepted_at = now() WHERE id = $1", [lose.id]), /only a revealed winning card/);

  // The season closes: the other revealed wins and the unscratched card are settled for the player.
  const waitingWins = results.filter((t) => t.result.cashKobo).length - 1;
  await sleep(Math.max(0, cyc.closeAt - Date.now()) + 200);
  await closeDueCycles(ctx);
  await revealClosedCycles(ctx);
  const after = ok(await api("GET", `/v1/tickets?cycleId=${cyc.id}`, { token: p.token })).tickets;
  assert.ok(after.every((t: any) => t.result && (!t.result.cashKobo || t.result.acceptedAt)), "every win accepted");
  const total = after.reduce((s: number, t: any) => s + t.result.cashKobo, 0);
  assert.equal(await wallet(), total);
  assert.ok(total >= 50_000 * (1 + waitingWins));
  assert.ok((await pool.query("SELECT count(*)::int AS n FROM audit_log WHERE action = 'ticket.prize_accepted' AND details->>'automatic' = 'true' AND entity_id = ANY($1)", [after.map((t: any) => t.id)])).rows[0].n >= waitingWins);
});

test("levels and held cards: instant cash released level by level as cards sell, and every payment gets its cards", async () => {
  const { releaseExpiredHolds } = await import("../src/modules/tickets.ts");
  const mt = admins.manager!.token, now = Date.now();
  fails(await api("POST", "/v1/admin/cycles", { token: mt, body: { name: "Uneven", ticketPriceKobo: 50_000, totalTickets: 41, maxTicketsPerAccount: 5, levels: 4,
    salesOpenAt: new Date(now).toISOString(), salesCloseAt: new Date(now + 3600_000).toISOString(), drawAt: new Date(now + 3600_000).toISOString() } }), 400, "INVALID_LEVELS");
  // 40 cards in 4 levels of 10; 8 instant prizes, so exactly 2 in each level. (A rich prize table needs an overridden policy.)
  const policy = config.policy!;
  config.policy = { ...POLICY, prizeShareBp: 10_000, instantShareBp: 10_000 };
  const cyc = await openCycle({ total: 40, closeInMs: 3600_000, cap: 20, name: "Levels", priceKobo: 50_000, levels: 4, escrowKobo: 400_000,
    tiers: [{ stage: "INSTANT", kind: "CASH", title: "₦500", cashKobo: 50_000, quantity: 8 }] });
  config.policy = policy;
  // Levels are shown to staff only, never to players.
  assert.equal(ok(await api("GET", `/v1/cycles/${cyc.id}`)).level, undefined);
  assert.equal(ok(await api("GET", `/v1/cycles/${cyc.id}`)).levels, undefined);
  const level = async () => ok(await api("GET", `/v1/admin/cycles/${cyc.id}`, { token: mt })).level;
  assert.deepEqual(await level(), { levels: 4, size: 10, current: 1, leftInLevel: 10, instantCashInLevelKobo: 100_000 });

  // Level 1 sells first; its 10 cards hold exactly its 2 prizes.
  const a = await newPlayer();
  await buy(a, cyc.id, 10);
  const leaf = async (userId: string) => (await pool.query("SELECT leaf_index FROM tickets WHERE cycle_id = $1 AND owner_id = $2 ORDER BY leaf_index", [cyc.id, userId])).rows.map((r: any) => r.leaf_index);
  assert.deepEqual(await leaf(a.id), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  let wins = 0;
  for (const t of ok(await api("GET", `/v1/tickets?cycleId=${cyc.id}`, { token: a.token })).tickets) {
    if (ok(await api("POST", `/v1/tickets/${t.id}/reveal`, { token: a.token })).ticket.result.cashKobo) wins++;
  }
  assert.equal(wins, 2, "each level releases exactly its share of the instant prizes");
  await new Promise((r) => setTimeout(r, 2100)); // the public figures are reused for two seconds
  assert.deepEqual(await level(), { levels: 4, size: 10, current: 2, leftInLevel: 10, instantCashInLevelKobo: 100_000 });

  // Cards are held from the moment an order is placed; held cards are not on sale to anyone else.
  const b = await newPlayer(), c = await newPlayer();
  const held = ok(await api("POST", "/v1/orders", { token: b.token, key: key(), body: { cycleId: cyc.id, quantity: 6 } }));
  const heldLeaves = (await pool.query("SELECT leaf_index FROM tickets WHERE order_id = $1 AND status = 'RESERVED'", [held.orderId])).rows.map((r: any) => r.leaf_index);
  assert.equal(heldLeaves.length, 6); assert.ok(heldLeaves.every((i: number) => i >= 10 && i < 20));
  await buy(c, cyc.id, 4);
  assert.ok((await leaf(c.id)).every((i: number) => i >= 10 && i < 20), "level 2 is finished before level 3 starts");
  const next = ok(await api("POST", "/v1/orders", { token: c.token, key: key(), body: { cycleId: cyc.id, quantity: 1 } }));
  assert.ok((await pool.query("SELECT leaf_index FROM tickets WHERE order_id = $1", [next.orderId])).rows[0].leaf_index >= 20, "held cards are skipped");
  // Paying for held cards gives exactly those cards.
  const paid = ok(await api("POST", "/v1/simulated-gateway/pay", { token: b.token, body: { paymentRef: held.paymentRef } }));
  assert.equal(paid.status, "FULFILLED");
  assert.deepEqual((await leaf(b.id)).sort((x: number, y: number) => x - y), heldLeaves.sort((x: number, y: number) => x - y));
  await assert.rejects(pool.query("UPDATE tickets SET status = 'SOLD', owner_id = $2, sold_at = now(), order_id = $3 WHERE order_id = $1",
    [next.orderId, b.id, held.orderId]), /only be sold to the order holding it/);

  // An unpaid order's hold is released when its payment window passes; if the payment then arrives and cards are
  // left, it still gets cards.
  await pool.query("UPDATE orders SET reserved_until = now() - interval '1 second' WHERE id = $1", [next.orderId]);
  assert.equal(await releaseExpiredHolds(ctx), 1);
  assert.equal((await pool.query("SELECT status FROM orders WHERE id = $1", [next.orderId])).rows[0].status, "EXPIRED");
  const late = ok(await api("POST", "/v1/simulated-gateway/pay", { token: c.token, body: { paymentRef: next.paymentRef } }));
  assert.equal(late.status, "FULFILLED"); assert.equal(late.ticketIds.length, 1);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM refunds rf JOIN orders o ON o.id = rf.order_id WHERE o.cycle_id = $1", [cyc.id])).rows[0].n, 0);
});

test("major prizes and large withdrawals need the liveness check; fraud rules alert Compliance about shared bank accounts and referral surges", async () => {
  const { accounts, post } = await import("../src/ledger.ts");
  const { withTx } = await import("../src/db.ts");
  const ct = admins.compliance!.token;
  // A large withdrawal (₦100,000 or more) needs the selfie check first.
  const p = await newPlayer({ name: "Liveness Player" });
  await withTx(pool, (db) => post(db, { kind: "ADJUSTMENT", reference: `test:credit:${p.id}`, memo: "test set-up", debit: accounts.companyBank(), credit: accounts.playerWinnings(p.id), amountKobo: 20_000_000 }));
  const acct = ok(await api("POST", "/v1/me/bank-accounts", { token: p.token, body: { bankCode: "058", accountNumber: "0111222333", accountName: "Liveness Player" } }));
  const pay = (amountKobo: number) => api("POST", "/v1/payouts", { token: p.token, key: key(), body: { amountKobo, bankAccountId: acct.id, pin: p.pin } });
  ok(await pay(9_999_900)); // just under: no check needed (held for a second approver, as before)
  fails(await pay(10_000_000), 403, "LIVENESS_REQUIRED");
  const unverified = await newPlayer({ verify: false });
  fails(await api("POST", "/v1/me/liveness", { token: unverified.token }), 403, "VERIFICATION_REQUIRED");
  assert.equal(ok(await api("POST", "/v1/me/liveness", { token: p.token })).kycTier, 2);
  assert.equal(ok(await api("GET", "/v1/me", { token: p.token })).kycTier, 2);
  ok(await pay(10_000_000));
  assert.equal((await pool.query("SELECT result FROM kyc_verifications WHERE user_id = $1 AND kind = 'LIVENESS'", [p.id])).rows[0].result, "PASS");

  // A major merchandise prize: claiming it needs the check.
  const ft = admins.fulfilment!.token;
  const big = ok(await api("POST", "/v1/admin/skus", { token: ft, body: { name: "Big prize", advertisedValueKobo: 10_000_000, serialised: true } })).id;
  ok(await api("POST", "/v1/admin/stock/receive", { token: ft, body: { skuId: big, supplierId, warehouseId, poReference: "PO-BIG", serialNumbers: ["SN-BIG-1"], acquisitionCostKobo: 1, landedCostKobo: 1 } }));
  const policy = config.policy!;
  config.policy = { ...POLICY, prizeShareBp: 10_000, instantShareBp: 0 };
  const cyc = await openCycle({ total: 200, closeInMs: 2500, cap: 200, name: "Major prize", priceKobo: 50_000, escrowKobo: 0,
    tiers: [{ stage: "FINAL_DRAW", kind: "MERCHANDISE", title: "Big prize", skuId: big, quantity: 1, drawOrder: 1 }] });
  config.policy = policy;
  const w = await newPlayer();
  await buy(w, cyc.id, 3);
  ok(await api("PUT", "/v1/me/next-of-kin", { token: w.token, body: { fullName: "Kin Person", relationship: "Sister", phone: "08030009999" } }));
  await sleep(Math.max(0, cyc.closeAt - Date.now()) + 2200);
  await closeDueCycles(ctx);
  for (const a of ["manager", "finance", "auditor"]) ok(await api("POST", `/v1/admin/cycles/${cyc.id}/draw/sign`, { token: admins[a]!.token }));
  ok(await api("POST", `/v1/admin/cycles/${cyc.id}/draw/execute`, { token: admins.manager!.token }));
  const claim = ok(await api("GET", "/v1/claims", { token: w.token })).claims.find((c: any) => c.title === "Big prize");
  const stockistId = await centre();
  const redeem = () => api("POST", `/v1/claims/${claim.id}/redeem`, { token: w.token, body: { method: "COLLECTION", stockistId, pin: w.pin } });
  fails(await redeem(), 403, "LIVENESS_REQUIRED");
  ok(await api("POST", "/v1/me/liveness", { token: w.token }));
  ok(await redeem());

  // Fraud rule: the same bank account on two players' profiles alerts Compliance and holds the second player's withdrawals.
  const q = await newPlayer({ name: "Second Holder" });
  ok(await api("POST", "/v1/me/bank-accounts", { token: q.token, body: { bankCode: "058", accountNumber: "0111222333", accountName: "Second Holder" } }));
  const shared = (await pool.query("SELECT severity, details FROM compliance_alerts WHERE kind = 'SHARED_BANK_ACCOUNT' AND entity_id = $1", [q.id])).rows;
  assert.equal(shared.length, 1); assert.equal(shared[0].severity, "CRITICAL"); assert.deepEqual(shared[0].details.alsoOn, [p.id]);

  // Fraud rule: 20 sign-ups with one invite code in a day alerts Compliance, once.
  const r = await newPlayer();
  const code = ok(await api("GET", "/v1/me/referrals", { token: r.token })).code;
  for (let i = 0; i < 21; i++) {
    const seq = ++phoneSeq, phone = "0803" + String(1000000 + seq);
    const otp = ok(await api("POST", "/v1/auth/otp", { body: { phone } }));
    ok(await api("POST", "/v1/auth/register", { body: { phone, code: otp.devCode, pin: "482915", referralCode: code } }));
  }
  const surge = (await pool.query("SELECT severity, details FROM compliance_alerts WHERE kind = 'REFERRAL_VELOCITY' AND entity_id = $1", [r.id])).rows;
  assert.equal(surge.length, 1); assert.equal(surge[0].severity, "WARNING"); assert.equal(surge[0].details.signUpsIn24Hours, 20);
  assert.ok(ok(await api("GET", "/v1/admin/compliance", { token: ct })));
});

test("the unsold-card counts kept by the database always match the cards themselves", async () => {
  const mismatched = (await pool.query(
    `SELECT c.id, c.name, coalesce((SELECT sum(unsold) FROM cycle_unsold u WHERE u.cycle_id = c.id), 0)::int AS counted,
            (SELECT count(*) FROM tickets t WHERE t.cycle_id = c.id AND t.status = 'UNSOLD')::int AS actual
     FROM cycles c WHERE EXISTS (SELECT 1 FROM tickets t WHERE t.cycle_id = c.id)`)).rows.filter((r: any) => r.counted !== r.actual);
  assert.deepEqual(mismatched, []);
  const cycles = (await pool.query("SELECT count(DISTINCT cycle_id)::int AS n FROM tickets")).rows[0].n;
  assert.ok(cycles >= 10, "checked across every cycle the tests created (sales, holds, releases, cancellations)");
});

test("compliance basics: privacy consent at sign-up, game rules accepted before buying, published probabilities, play summary", async () => {
  // Opening an account needs the privacy policy accepted; marketing consent is optional and can change.
  const seq = ++phoneSeq, phone = "0803" + String(1000000 + seq);
  const otp = ok(await api("POST", "/v1/auth/otp", { body: { phone } }));
  fails(await api("POST", "/v1/auth/register", { raw: true, body: { phone, code: otp.devCode, pin: "482915" } }), 400, "PRIVACY_CONSENT_REQUIRED");
  const reg = ok(await api("POST", "/v1/auth/register", { raw: true, body: { phone, code: otp.devCode, pin: "482915", acceptPrivacy: true, marketing: false } }));
  const p = { token: reg.token, phone, pin: "482915", id: reg.userId };
  let priv = ok(await api("GET", "/v1/me/privacy", { token: p.token }));
  assert.equal(priv.privacyPolicy.granted, true); assert.equal(priv.privacyPolicy.version, priv.currentPolicyVersion); assert.equal(priv.marketing, false);
  priv = ok(await api("PUT", "/v1/me/privacy", { token: p.token, body: { marketing: true } }));
  assert.equal(priv.marketing, true); assert.equal(priv.history.length, 3);
  await assert.rejects(pool.query("DELETE FROM consents WHERE user_id = $1", [p.id]), /append-only/);
  ok(await api("POST", "/v1/me/verify", { token: p.token, body: { kind: "NIN", number: String(10000000000 + seq), fullName: "Rules Reader", dateOfBirth: "1990-05-17", stateCode: "NG-NI" } }));

  // The rules are published with their probabilities, and must be accepted (that exact version) before buying.
  const cyc = await openCycle({ total: 100, closeInMs: 3600_000, cap: 20, name: "Rules check 2" });
  const rules = ok(await api("GET", `/v1/cycles/${cyc.id}/rules`));
  assert.equal(rules.text, "Published rules"); assert.equal(rules.version, rules.sha256.slice(0, 12));
  assert.deepEqual(rules.instant, [{ cashKobo: 50_000, winners: 2, oneIn: 50 }]);
  assert.equal(rules.finalDrawPrizes, 3); assert.equal(rules.finalDrawPercentAtFullSales, 3);
  const order = { cycleId: cyc.id, quantity: 1 };
  fails(await api("POST", "/v1/orders", { raw: true, token: p.token, key: key(), body: order }), 403, "RULES_NOT_ACCEPTED");
  assert.equal(ok(await api("GET", `/v1/me/today?cycleId=${cyc.id}`, { token: p.token })).rulesAccepted, false);
  assert.equal(ok(await api("POST", `/v1/cycles/${cyc.id}/rules/accept`, { token: p.token })).version, rules.version);
  ok(await api("POST", `/v1/cycles/${cyc.id}/rules/accept`, { token: p.token })); // accepting again is harmless
  assert.equal(ok(await api("GET", `/v1/me/today?cycleId=${cyc.id}`, { token: p.token })).rulesAccepted, true);
  const paid = ok(await api("POST", "/v1/orders", { raw: true, token: p.token, key: key(), body: { cycleId: cyc.id, quantity: 4 } }));
  ok(await api("POST", "/v1/simulated-gateway/pay", { token: p.token, body: { paymentRef: paid.paymentRef } }));
  await assert.rejects(pool.query("UPDATE cycles SET rules_text = 'Changed rules' WHERE id = $1", [cyc.id]), /cannot be changed after approval/);
  await assert.rejects(pool.query("DELETE FROM rule_acceptances WHERE user_id = $1", [p.id]), /append-only/);

  // The play summary: spent, cash won, the difference, cards and final-draw entries.
  const sum = ok(await api("GET", "/v1/me/summary", { token: p.token }));
  assert.equal(sum.spentKobo, 4 * N200); assert.equal(sum.cards, 4); assert.equal(sum.finalDrawEntries, 4);
  assert.equal(sum.netKobo, sum.cashWonKobo - sum.spentKobo);
});
