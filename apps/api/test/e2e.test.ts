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
import { buildServer } from "../src/http.ts";
import { migrate } from "../src/migrate.ts";
import { closeDueCycles } from "../src/modules/cycles.ts";

const adminUrl = process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/postgres";
const dbName = "wr_test_" + randomBytes(4).toString("hex");
const dbUrl = (() => { const u = new URL(adminUrl); u.pathname = "/" + dbName; return u.toString(); })();

let pool: Pool, app: FastifyInstance, ctx: Ctx, config: Config;
const N200 = 20_000; // ₦200 in kobo

interface Res { status: number; body: any }
async function api(method: "GET" | "POST" | "PUT", url: string, opts: { token?: string | undefined; body?: unknown; key?: string } = {}, server = app): Promise<Res> {
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

/** Creates a cycle and takes it through approval, commitment and opening. */
async function openCycle(o: { total: number; closeInMs: number; cap: number; name: string }): Promise<{ id: string; closeAt: number }> {
  const now = Date.now();
  const closeAt = now + o.closeInMs;
  const c = ok(await api("POST", "/v1/admin/cycles", { token: admins.manager!.token, body: {
    name: o.name, ticketPriceKobo: N200, totalTickets: o.total, maxTicketsPerAccount: o.cap,
    salesOpenAt: new Date(now - 1000).toISOString(), salesCloseAt: new Date(closeAt).toISOString(), drawAt: new Date(closeAt).toISOString() } }));
  const tier = (b: object) => api("POST", `/v1/admin/cycles/${c.id}/prize-tiers`, { token: admins.manager!.token, body: b });
  ok(await tier({ stage: "INSTANT", kind: "CASH", title: "₦10,000", cashKobo: 1_000_000, quantity: 1 }));
  ok(await tier({ stage: "INSTANT", kind: "CASH", title: "₦500", cashKobo: 50_000, quantity: 10 }));
  ok(await tier({ stage: "FINAL_DRAW", kind: "CASH", title: "₦100,000 cash", cashKobo: 10_000_000, quantity: 1, drawOrder: 1 }));
  ok(await tier({ stage: "FINAL_DRAW", kind: "MERCHANDISE", title: "Solar freezer", skuId: skuId, quantity: 2, drawOrder: 2 }));
  ok(await api("PUT", `/v1/admin/cycles/${c.id}/evidence`, { token: admins.manager!.token, body: {
    financialModelRef: "fm-1", rulesDocumentRef: "rules-1", rulesText: "Published rules", escrowReference: "ESC-1",
    escrowFundedKobo: 11_500_000, auditorAdminId: admins.auditor!.id } }));
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
    payoutApprovalThresholdKobo: 500_000, bankCoolingOffHours: 0, beaconPeriodSeconds: 1, sessionDays: 30,
    maxLimitsKobo: { daily: 2_000_000, weekly: 8_000_000, monthly: 20_000_000 }, rateLimits: { auth: 100_000, general: 1_000_000 }, cookieSecure: true,
  };
  ctx = { pool, config, keys: new LocalKeyService(config.masterKey), beacon: new SimulatedBeacon(pool, config.beaconPeriodSeconds) };
  app = buildServer(ctx);

  const roles: Record<string, string> = { manager: "CYCLE_MANAGER", manager2: "CYCLE_MANAGER", finance: "FINANCE", approver: "PAYOUT_APPROVER", fulfilment: "FULFILMENT", compliance: "COMPLIANCE", auditor: "AUDITOR", auditor2: "AUDITOR", security: "SECURITY_ADMIN", security2: "SECURITY_ADMIN" };
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
  skuId = ok(await api("POST", "/v1/admin/skus", { token: ft, body: { name: "Solar freezer 200L", advertisedValueKobo: 55_000_000, serialised: true, warrantyMonths: 24 } })).id;
  supplierId = ok(await api("POST", "/v1/admin/suppliers", { token: ft, body: { name: "Test Supplier", country: "NG" } })).id;
  warehouseId = ok(await api("POST", "/v1/admin/warehouses", { token: ft, body: { name: "Minna", address: "1 Test Road, Minna", stateCode: "NG-NI" } })).id;
  ok(await api("POST", "/v1/admin/stock/receive", { token: ft, body: { skuId, supplierId, warehouseId, poReference: "PO-1", serialNumbers: ["SN-1", "SN-2", "SN-3", "SN-4", "SN-5"], acquisitionCostKobo: 38_000_000, landedCostKobo: 42_000_000 } }));
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
  const mk = (b: object) => api("POST", "/v1/admin/cycles", { token: admins.manager!.token, body: { name: "Rules check", ticketPriceKobo: N200, totalTickets: 20, maxTicketsPerAccount: 5, salesOpenAt: new Date(now - 1000).toISOString(), salesCloseAt: new Date(now + 3600_000).toISOString(), drawAt: new Date(now + 3600_000).toISOString(), ...b } });
  fails(await mk({ ticketPriceKobo: 10_000 }), 400, "INVALID_PRICE");
  fails(await api("POST", "/v1/admin/cycles", { token: admins.finance!.token, body: {} }), 400, "INVALID_REQUEST");
  fails(await api("POST", "/v1/admin/cycles", { token: admins.finance!.token, body: { name: "x", ticketPriceKobo: N200, totalTickets: 20, maxTicketsPerAccount: 5, salesOpenAt: "2030-01-01", salesCloseAt: "2030-01-02", drawAt: "2030-01-03" } }), 403, "ROLE_REQUIRED");
  const c = ok(await mk({}));
  const url = `/v1/admin/cycles/${c.id}`;
  fails(await api("POST", `${url}/prize-tiers`, { token: admins.manager!.token, body: { stage: "INSTANT", kind: "CASH", title: "too big", cashKobo: 5_000_000, quantity: 1 } }), 400, "INVALID_PRIZE");
  ok(await api("POST", `${url}/prize-tiers`, { token: admins.manager!.token, body: { stage: "INSTANT", kind: "CASH", title: "₦500", cashKobo: 50_000, quantity: 4 } }));
  fails(await api("POST", `${url}/open`, { token: admins.manager!.token }), 409, "RULE_VIOLATION");
  ok(await api("POST", `${url}/submit`, { token: admins.manager!.token }));
  fails(await api("POST", `${url}/approve`, { token: admins.manager!.token }), 409, "RULE_VIOLATION"); // drafter cannot approve
  ok(await api("POST", `${url}/approve`, { token: admins.manager2!.token }));
  fails(await api("POST", `${url}/approve`, { token: admins.finance!.token }), 409, "RULE_VIOLATION"); // no evidence yet
  fails(await api("PUT", `${url}/evidence`, { token: admins.manager!.token, body: { financialModelRef: "fm", rulesDocumentRef: "r", rulesText: "rules", escrowReference: "E", escrowFundedKobo: 200_000, auditorAdminId: admins.finance!.id } }), 400, "NOT_AN_AUDITOR");
  ok(await api("PUT", `${url}/evidence`, { token: admins.manager!.token, body: { financialModelRef: "fm", rulesDocumentRef: "r", rulesText: "rules", escrowReference: "E", escrowFundedKobo: 199_999, auditorAdminId: admins.auditor!.id } }));
  fails(await api("POST", `${url}/approve`, { token: admins.finance!.token }), 409, "RULE_VIOLATION"); // escrow ₦1 short
  ok(await api("PUT", `${url}/evidence`, { token: admins.manager!.token, body: { financialModelRef: "fm", rulesDocumentRef: "r", rulesText: "rules", escrowReference: "E", escrowFundedKobo: 200_000, auditorAdminId: admins.auditor!.id } }));
  assert.equal(ok(await api("POST", `${url}/approve`, { token: admins.finance!.token })).status, "APPROVED");
  // Locked from here on.
  fails(await api("POST", `${url}/prize-tiers`, { token: admins.manager!.token, body: { stage: "INSTANT", kind: "CASH", title: "late", cashKobo: 100_000, quantity: 1 } }), 409, "RULE_VIOLATION");
  fails(await api("PUT", `${url}/evidence`, { token: admins.manager!.token, body: { financialModelRef: "fm2", rulesDocumentRef: "r", rulesText: "new rules", escrowReference: "E", escrowFundedKobo: 0, auditorAdminId: admins.auditor!.id } }), 409, "RULE_VIOLATION");
  fails(await api("GET", `/v1/cycles/${c.id}`), 404, "NOT_FOUND"); // not public until committed
  const committed = ok(await api("POST", `${url}/commit`, { token: admins.manager!.token }));
  assert.equal(committed.tickets, 20);
  fails(await api("POST", `${url}/commit`, { token: admins.manager!.token }), 409, "NOT_APPROVED");
  const pub = ok(await api("GET", `/v1/cycles/${c.id}`));
  assert.equal(pub.commitment.ticket_merkle_root, committed.merkleRoot);
  assert.deepEqual(pub.instantWinOdds, { winners: 4, outOf: 20 });
  assert.equal(pub.mode, "SIMULATED");
  // Outcomes are not readable in the database before a card is revealed.
  const rows = (await pool.query("SELECT outcome_ciphertext, revealed_outcome FROM tickets WHERE cycle_id = $1", [c.id])).rows;
  assert.equal(rows.length, 20);
  for (const r of rows) {
    assert.equal(r.revealed_outcome, null);
    assert.ok(!r.outcome_ciphertext.toString("latin1").includes("CASH") && !r.outcome_ciphertext.toString("latin1").includes("NONE"));
  }
  // Even with direct database access, a real-money cycle cannot be opened without licence and certification.
  await assert.rejects(pool.query("UPDATE cycles SET mode = 'REAL_MONEY' WHERE id = $1", [c.id]), /locked/);
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

test("sell-out under load: no card sold twice, late payer refunded, cycle closes itself", async () => {
  // 20 cards are sold and 3 are held by an unpaid order; 40 remain unsold. Four players race for 20 each.
  const racers = await Promise.all([1, 2, 3, 4].map(() => newPlayer()));
  const orders = await Promise.all(racers.map((p) => api("POST", "/v1/orders", { token: p.token, key: key(), body: { cycleId: cycleA.id, quantity: 20 } })));
  const results = await Promise.all(racers.map((p, i) => api("POST", "/v1/simulated-gateway/pay", { token: p.token, body: { paymentRef: ok(orders[i]!).paymentRef } })));
  const statuses = results.map((r) => ok(r).status).sort();
  assert.deepEqual(statuses, ["FULFILLED", "FULFILLED", "REFUNDED", "REFUNDED"]);
  players.push(...racers.filter((_, i) => results[i]!.body.status === "FULFILLED"));

  const sold = (await pool.query("SELECT id, owner_id, order_id FROM tickets WHERE cycle_id = $1 AND status <> 'UNSOLD'", [cycleA.id])).rows;
  assert.equal(sold.length, 60);
  assert.equal(new Set(sold.map((t: any) => t.id)).size, 60);
  const perOrder = (await pool.query("SELECT o.quantity, count(t.id)::int AS n FROM orders o JOIN tickets t ON t.order_id = o.id WHERE o.cycle_id = $1 GROUP BY o.id", [cycleA.id])).rows;
  for (const r of perOrder) assert.equal(r.quantity, r.n);
  // Sold out before the closing date: the cycle is closed straight away.
  assert.equal(ok(await api("GET", `/v1/cycles/${cycleA.id}`)).status, "CLOSED");
  fails(await api("POST", "/v1/orders", { token: racers[0]!.token, key: key(), body: { cycleId: cycleA.id, quantity: 1 } }), 409, "SALES_CLOSED");
  // Revenue is exactly 60 cards; refunds net to zero.
  const rev = (await pool.query("SELECT -balance_kobo AS b FROM ledger_balances WHERE code = $1", [`TICKET_REVENUE:${cycleA.id}`])).rows[0].b;
  assert.equal(rev, 60 * N200);
  assert.equal((await pool.query("SELECT balance_kobo AS b FROM ledger_balances WHERE code = 'REFUNDS_PAYABLE'")).rows[0].b, 0);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM refunds WHERE reason = 'NO_TICKET_ISSUED'")).rows[0].n, 2);
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
    if (r.ticket.result.cashKobo) { wins++; winTotal += r.ticket.result.cashKobo; }
  }
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
  assert.deepEqual(t, { revealed: 60, wins: 11 });
  const expense = (await pool.query("SELECT balance_kobo AS b FROM ledger_balances WHERE code = $1", [`PRIZE_EXPENSE:${cycleA.id}`])).rows[0].b;
  assert.equal(expense, 1_000_000 + 10 * 50_000 + 10_000_000);
  // Merchandise winners have an open claim with the 90-day window.
  const claims = (await pool.query("SELECT status, (expires_at - created_at) AS win FROM prize_claims WHERE stage = 'FINAL_DRAW' AND status = 'ENTITLED'")).rows;
  assert.equal(claims.length, 2);
  assert.equal(claims[0].win.days, 90);
  // The record cannot be altered afterwards.
  await assert.rejects(pool.query("UPDATE draw_winners SET position = 9 WHERE cycle_id = $1", [cycleA.id]), /append-only/);
});

test("closing date with unsold cards: the draw still runs, over sold cards only", async () => {
  const b = await openCycle({ total: 30, closeInMs: 2500, cap: 10, name: "Cycle B" });
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
  // The ₦100,000 draw winner.
  const winnerId = (await pool.query("SELECT user_id FROM prize_claims pc JOIN prize_tiers pt ON pt.id = pc.prize_tier_id WHERE pt.cycle_id = $1 AND pc.stage = 'FINAL_DRAW' AND pt.kind = 'CASH'", [cycleA.id])).rows[0].user_id;
  const w = players.find((p) => p.id === winnerId)!;
  const name = ok(await api("GET", "/v1/me", { token: w.token })).fullName;
  const start = ok(await api("GET", "/v1/wallet", { token: w.token })).balanceKobo;
  assert.ok(start >= 10_000_000);

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
  const small = ok(await pay({ amountKobo: 100_000, bankAccountId: acct.id, pin: w.pin }, k));
  assert.equal(small.status, "CONFIRMED");
  assert.equal(ok(await pay({ amountKobo: 100_000, bankAccountId: acct.id, pin: w.pin }, k)).id, small.id);
  assert.equal(ok(await api("GET", "/v1/wallet", { token: w.token })).balanceKobo, start - 100_000);

  // Two withdrawals of the whole balance at once: only one can succeed.
  const rest = start - 100_000;
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
  const reg = await web.inject({ method: "POST", url: "/v1/auth/register", payload: { phone, code: otp.devCode, pin: "482915" } });
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
  assert.equal(detail.cashCoverRequiredKobo, 11_500_000);
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
  const c = ok(await api("POST", "/v1/admin/cycles", { token: mt, body: { name: "Stock check", ticketPriceKobo: N200, totalTickets: 10, maxTicketsPerAccount: 5, salesOpenAt: new Date(now).toISOString(), salesCloseAt: new Date(now + 3600_000).toISOString(), drawAt: new Date(now + 3600_000).toISOString() } }));
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
  ok(await api("POST", "/v1/admin/stock/receive", { token: ft, body: { skuId, supplierId, warehouseId, poReference: "PO-2", serialNumbers: ["SN-6"], acquisitionCostKobo: 38_000_000, landedCostKobo: 42_000_000 } }));
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
  if (!hadKin) fails(await redeem(w1, claim1, { method: "COLLECTION", pin: w1.pin }), 403, "NEXT_OF_KIN_REQUIRED");
  await setKin(w1); // adding a next of kin for the first time is allowed even with a prize waiting
  fails(await redeem(w1, claim1, { method: "COLLECTION", pin: "135790" }), 403, "PIN_REQUIRED");
  fails(await redeem(w1, claim1, { method: "DELIVERY", pin: w1.pin }), 400, "ADDRESS_REQUIRED");
  const stranger = players.find((p) => p.id !== w1.id && p.id !== open[1].user_id) ?? await newPlayer();
  fails(await redeem(stranger, claim1, { method: "COLLECTION", pin: stranger.pin }), 404, "NOT_FOUND");
  assert.equal(ok(await redeem(w1, claim1, { method: "DELIVERY", address: "12 Bosso Road, Minna", pin: w1.pin })).status, "VERIFIED");
  fails(await redeem(w1, claim1, { method: "COLLECTION", pin: w1.pin }), 409, "ALREADY_CLAIMED");
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
  fails(await api("POST", `/v1/admin/fulfilment/${claim1}/handover`, { token: ft, body: { code } }), 400, "INVALID_REQUEST"); // photo is mandatory
  assert.equal(ok(await api("POST", `/v1/admin/fulfilment/${claim1}/handover`, { token: ft, body: { code, photoRef: "handover/claim1.jpg", warrantyDocumentRef: "warranty/SN.pdf" } })).status, "DELIVERED");
  fails(await api("POST", `/v1/admin/fulfilment/${claim1}/handover`, { token: ft, body: { code, photoRef: "p.jpg" } }), 409, "NOT_IN_TRANSIT");
  const delivered = ok(await api("GET", "/v1/claims", { token: w1.token })).claims.find((x: any) => x.id === claim1);
  assert.equal(delivered.status, "DELIVERED"); assert.equal(delivered.handoverCode, null); assert.equal(delivered.warranty_months, 24); assert.ok(delivered.serial_number);
  assert.equal((await pool.query("SELECT u.status FROM stock_units u JOIN prize_claims pc ON pc.stock_unit_id = u.id WHERE pc.id = $1", [claim1])).rows[0].status, "DELIVERED");

  // --- Guessing the code locks the handover. ---
  const w2 = playerOf(open[1].user_id), claim2 = open[1].id;
  await setKin(w2);
  ok(await redeem(w2, claim2, { method: "COLLECTION", pin: w2.pin }));
  ok(await api("POST", `/v1/admin/fulfilment/${claim2}/dispatch`, { token: ft, body: {} })); // collection needs no carrier
  const code2 = ok(await api("GET", "/v1/claims", { token: w2.token })).claims.find((x: any) => x.id === claim2).handoverCode;
  const bad = code2 === "111111" ? "111112" : "111111";
  for (let i = 0; i < 5; i++) fails(await api("POST", `/v1/admin/fulfilment/${claim2}/handover`, { token: ft, body: { code: bad, photoRef: "p.jpg" } }), 403, "WRONG_CODE");
  fails(await api("POST", `/v1/admin/fulfilment/${claim2}/handover`, { token: ft, body: { code: code2, photoRef: "p.jpg" } }), 429, "HANDOVER_LOCKED");
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM compliance_alerts WHERE kind = 'HANDOVER_CODE_FAILURES' AND entity_id = $1", [claim2])).rows[0].n, 1);

  // --- Records: costs, serial numbers, where every unit is. ---
  const inv = ok(await api("GET", "/v1/admin/inventory", { token: admins.auditor!.token }));
  const item = inv.items.find((i: any) => i.id === skuId);
  assert.deepEqual([item.in_stock, item.reserved, item.with_winners, item.delivered], [0, 4, 1, 1]);
  assert.equal(item.avg_landed_cost_kobo, 42_000_000);
  assert.equal(item.stock_value_kobo, 5 * 42_000_000);
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
  // Two more freezers so a new cycle's merchandise prizes can be secured.
  ok(await api("POST", "/v1/admin/stock/receive", { token: ft, body: { skuId, supplierId, warehouseId, poReference: "PO-3", serialNumbers: ["SN-7", "SN-8"], acquisitionCostKobo: 38_000_000, landedCostKobo: 42_000_000 } }));
  // 11 cards and 11 instant prizes: every card wins, so the prize rules are easy to check.
  const v = await openCycle({ total: 11, closeInMs: 3600_000, cap: 11, name: "Void check" });
  const [p1, p2, p3, p4] = [await newPlayer(), await newPlayer(), await newPlayer(), await newPlayer()];
  await buy(p1, v.id, 4); await buy(p2, v.id, 3); await buy(p3, v.id, 2);
  const cards = async (p: Player) => ok(await api("GET", `/v1/tickets?cycleId=${v.id}`, { token: p.token })).tickets;
  const reveal = async (p: Player, id: string) => ok(await api("POST", `/v1/tickets/${id}/reveal`, { token: p.token })).ticket.result.cashKobo as number;
  const p1Cards = await cards(p1);
  const w1 = (await reveal(p1, p1Cards[0].id)) + (await reveal(p1, p1Cards[1].id));
  const p3Cards = await cards(p3);
  const w3 = await reveal(p3, p3Cards[0].id);
  const wallet = async (p: Player) => ok(await api("GET", "/v1/wallet", { token: p.token }));
  const orderOf = async (p: Player) => (await pool.query("SELECT id FROM orders WHERE user_id = $1 AND cycle_id = $2 AND status = 'FULFILLED'", [p.id, v.id])).rows[0].id as string;
  const revenue = async () => 0 - (await pool.query("SELECT coalesce(sum(e.amount_kobo),0)::bigint AS b FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id WHERE a.code = $1", [`TICKET_REVENUE:${v.id}`])).rows[0].b;
  assert.equal(await revenue(), 9 * N200);

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
  assert.equal(await revenue(), 7 * N200);
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
  assert.deepEqual(voided, { status: "VOID", refunds: 2, refundedKobo: 7 * N200 });

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
  // Instant prizes already revealed are honoured; unscratched cards can no longer be revealed.
  assert.equal((await wallet(p1)).balanceKobo, w1);
  fails(await api("POST", `/v1/tickets/${p1Cards[2].id}/reveal`, { token: p1.token }), 409, "CARD_CANCELLED");
  // The payment that arrives after cancellation is refunded automatically.
  assert.equal(ok(await api("POST", "/v1/simulated-gateway/pay", { token: p4.token, body: { paymentRef: late.paymentRef } })).status, "REFUNDED");
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
    [60, 60 * N200, 1_500_000, 10_000_000, 0, 2 * 42_000_000, 2_500_000]);
  assert.equal(a.contribution_kobo, 60 * N200 - 1_500_000 - 10_000_000 - 84_000_000 - 2_500_000);
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
  assert.equal(s.result_kobo, s.collected_kobo - s.refunded_kobo - s.cash_prizes_kobo - s.operating_expenses_kobo);
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
  assert.ok(lines.some((l) => l.includes(String((60 * N200 - 98_000_000) / 100))), "negative contribution stays a number");
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
  assert.deepEqual(done, { status: "ARCHIVED", published: 30, stockReleased: 2 });
  fails(await api("POST", `/v1/admin/cycles/${b}/archive/confirm`, { token: fin }), 409, "NOT_REQUESTED");
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM stock_units WHERE reserved_cycle_id = $1", [b])).rows[0].n, 0);
  assert.equal(ok(await api("GET", `/v1/cycles/${b}`)).status, "ARCHIVED");

  // Anyone, without signing in, can fetch every card and rebuild the fingerprint published before sales.
  const pub = ok(await api("GET", `/v1/cycles/${b}/tickets`));
  assert.equal(pub.total, 30); assert.equal(pub.tickets.length, 30);
  const leaves = pub.tickets.map((t: any) => ticketLeafHash({ cycleId: b, serial: t.serial, outcome: t.outcome, salt: Buffer.from(t.salt, "hex") }));
  assert.equal(new MerkleTree(leaves).root.toString("hex"), ok(await api("GET", `/v1/cycles/${b}`)).commitment.ticket_merkle_root);
  const count = (o: string) => pub.tickets.filter((t: any) => t.outcome === o).length;
  assert.deepEqual([count("CASH:1000000"), count("CASH:50000"), count("NONE")], [1, 10, 19]); // exactly the advertised prizes
  assert.deepEqual([pub.tickets.filter((t: any) => t.sale_status === "UNSOLD").length, pub.tickets.filter((t: any) => t.sale_status === "REVEALED").length], [25, 5]);
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
