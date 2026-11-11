// End-to-end test of a whole simulated prize cycle against a real PostgreSQL.
// Needs TEST_DATABASE_URL pointing at a server where it may create a database.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import pg from "pg";
import type { FastifyInstance } from "fastify";
import { deriveDrawSeed, entriesHash, runDraw, verifySecretCommitment, verifyTicket } from "@wiifarm/game-core";
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
  ok(await api("POST", `/v1/admin/cycles/${c.id}/submit`, { token: admins.manager!.token }));
  ok(await api("POST", `/v1/admin/cycles/${c.id}/approve`, { token: admins.manager2!.token }));
  assert.equal(ok(await api("POST", `/v1/admin/cycles/${c.id}/approve`, { token: admins.finance!.token })).status, "APPROVED");
  ok(await api("POST", `/v1/admin/cycles/${c.id}/commit`, { token: admins.manager!.token }));
  ok(await api("POST", `/v1/admin/cycles/${c.id}/open`, { token: admins.manager!.token }));
  return { id: c.id, closeAt };
}

let skuId: string;
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
    maxLimitsKobo: { daily: 2_000_000, weekly: 8_000_000, monthly: 20_000_000 }, rateLimits: { auth: 100_000, general: 1_000_000 },
  };
  ctx = { pool, config, keys: new LocalKeyService(config.masterKey), beacon: new SimulatedBeacon(pool, config.beaconPeriodSeconds) };
  app = buildServer(ctx);

  const roles: Record<string, string> = { manager: "CYCLE_MANAGER", manager2: "CYCLE_MANAGER", finance: "FINANCE", approver: "PAYOUT_APPROVER", compliance: "COMPLIANCE", auditor: "AUDITOR", auditor2: "AUDITOR", security: "SECURITY_ADMIN", security2: "SECURITY_ADMIN" };
  const ids: Record<string, string> = {};
  for (const name of Object.keys(roles)) {
    ids[name] = (await pool.query("INSERT INTO admin_users (email, full_name) VALUES ($1, $2) RETURNING id", [`${name}@example.test`, name])).rows[0].id;
  }
  for (const [name, role] of Object.entries(roles)) {
    await pool.query("INSERT INTO admin_roles (admin_user_id, role, granted_by) VALUES ($1, $2, $3)", [ids[name], role, name === "security" ? ids.security2 : ids.security]);
    admins[name] = { id: ids[name]!, token: ok(await api("POST", "/v1/admin/dev-login", { body: { email: `${name}@example.test` } })).token };
  }
  skuId = (await pool.query("INSERT INTO skus (name, advertised_value_kobo) VALUES ('Solar freezer 200L', 55000000) RETURNING id")).rows[0].id;
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
  fails(await api("POST", `${url}/prize-tiers`, { token: admins.manager!.token, body: { stage: "INSTANT", kind: "CASH", title: "too big", cashKobo: 5_000_000, quantity: 1 } }), 409, "RULE_VIOLATION");
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
