// Creates demo administrators and one open demo cycle, using the same
// approval steps as real use (drafter, two approvers, auditor). Simulation only.
import { SimulatedBeacon } from "./beacon.ts";
import { assertSimulationAcknowledged, loadConfig } from "./config.ts";
import type { Ctx } from "./context.ts";
import { LocalKeyService } from "./crypto.ts";
import { createPool } from "./db.ts";
import { migrate } from "./migrate.ts";
import type { Admin, Role } from "./modules/admin.ts";
import * as cycles from "./modules/cycles.ts";
import * as inventory from "./modules/inventory.ts";
import { SimulatedMessenger } from "./messenger.ts";

/** First wave: ₦500 cards; 400,000 of them in the real season. The demo uses fewer so it starts quickly. */
export const TICKET_PRICE_KOBO = 50_000;
export const FIRST_WAVE_TICKETS = 400_000;
const DEMO_TICKETS = 20_000;

/**
 * The first-wave prize plan, scaled to a season of `total` cards. Prize money is
 * 50% of full sell-out sales and instant cash 10% of that (company policy).
 * At 400,000 cards the instant table below uses exactly the ₦10,000,000 instant
 * budget; smaller demo seasons get the same table scaled down (rounded down, so
 * it never exceeds the budget). Final-draw prizes are a placeholder until the
 * real list (with images) is supplied: one car, then other prizes while they
 * fit the final-draw budget.
 */
export function firstWavePlan(total: number): {
  instant: [number, number][];
  draw: { title: string; quantity: number; cashKobo?: number; valueKobo?: number; stock?: number; serialised: boolean }[];
} {
  const perWave: [number, number][] = [[1_000_000, 100], [500_000, 200], [200_000, 750], [100_000, 2_500], [50_000, 8_000]];
  const instant = perWave.map(([c, q]) => [c, Math.floor((q * total) / FIRST_WAVE_TICKETS)] as [number, number]).filter(([, q]) => q > 0);
  if (!instant.length) instant.push([50_000, 1]);
  const drawBudget = Math.floor(total * TICKET_PRICE_KOBO * 0.5) - Math.floor(total * TICKET_PRICE_KOBO * 0.5 * 0.1);
  const candidates = [
    { title: "Car", quantity: 1, valueKobo: 3_000_000_000, stock: 1, serialised: true, minTickets: 200_000 }, // demo value: to be confirmed
    { title: "Electric motorcycle", quantity: 1, valueKobo: 150_000_000, stock: 1, serialised: true, minTickets: 0 },
    { title: "₦100,000 cash", quantity: 1, cashKobo: 10_000_000, serialised: false, minTickets: 0 },
    { title: "Solar freezer 200L", quantity: 2, valueKobo: 55_000_000, stock: 3, serialised: true, minTickets: 0 },
    { title: "NaijaSweetRice 50kg", quantity: 5, valueKobo: 7_500_000, stock: 8, serialised: false, minTickets: 0 },
  ];
  const draw = [];
  let used = 0;
  for (const { minTickets, ...p } of candidates) {
    const value = (p.cashKobo ?? p.valueKobo!) * p.quantity;
    if (total >= minTickets && used + value <= drawBudget) { draw.push(p); used += value; }
  }
  return { instant, draw };
}

export async function seedDemo(ctx: Ctx, opts: { name?: string; tickets?: number; closeInMinutes?: number } = {}): Promise<{ cycleId: string; admins: Record<string, Admin> }> {
  const people: Record<string, Role> = { manager: "CYCLE_MANAGER", operations: "CYCLE_MANAGER", finance: "FINANCE", approver: "PAYOUT_APPROVER", fulfilment: "FULFILMENT", support: "SUPPORT", compliance: "COMPLIANCE", auditor: "AUDITOR", security: "SECURITY_ADMIN", security2: "SECURITY_ADMIN" };
  const admins: Record<string, Admin> = {};
  for (const name of Object.keys(people)) {
    const email = `${name}@demo.wiifarm.test`;
    const row = await ctx.pool.query<{ id: string }>(
      `INSERT INTO admin_users (email, full_name) VALUES ($1, $2) ON CONFLICT (email) DO UPDATE SET full_name = EXCLUDED.full_name RETURNING id`, [email, `Demo ${name}`]);
    admins[name] = { id: row.rows[0]!.id, email, fullName: `Demo ${name}`, roles: [people[name]!] };
  }
  for (const [name, role] of Object.entries(people)) {
    await ctx.pool.query("INSERT INTO admin_roles (admin_user_id, role, granted_by) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
      [admins[name]!.id, role, admins[name === "security" ? "security2" : "security"]!.id]);
  }
  // Merchandise is received into the warehouse first, with its costs; it is reserved to the cycle before approval.
  const f = admins.fulfilment!;
  const tag = Date.now().toString(36);
  const supplier = await inventory.createSupplier(ctx, f, { name: "Demo Supplier " + tag, country: "NG" });
  const warehouse = await inventory.createWarehouse(ctx, f, { name: "Minna warehouse " + tag, address: "Demo address, Minna", stateCode: "NG-NI" });
  const sku = async (name: string, valueKobo: number, units = 0, serialised = false): Promise<string> => {
    const { id } = await inventory.createItem(ctx, f, { name, advertisedValueKobo: valueKobo, serialised, warrantyMonths: serialised ? 12 : 0 });
    if (units) {
      await inventory.receiveStock(ctx, f, {
        skuId: id, supplierId: supplier.id, warehouseId: warehouse.id, poReference: `PO-${tag}-${name.slice(0, 5)}`,
        ...(serialised ? { serialNumbers: Array.from({ length: units }, (_, i) => `SN-${tag}-${name.slice(0, 3).toUpperCase()}-${i + 1}`) } : { quantity: units }),
        acquisitionCostKobo: Math.round(valueKobo * 0.7), landedCostKobo: Math.round(valueKobo * 0.78) });
    }
    return id;
  };

  const now = Date.now(), close = new Date(now + (opts.closeInMinutes ?? 7 * 24 * 60) * 60_000).toISOString();
  const m = admins.manager!;
  const total = opts.tickets ?? DEMO_TICKETS;
  const { id } = await cycles.createCycle(ctx, m, {
    name: opts.name ?? "Harvest Cycle 1", ticketPriceKobo: TICKET_PRICE_KOBO, totalTickets: total, maxTicketsPerAccount: 200,
    salesOpenAt: new Date(now - 1000).toISOString(), salesCloseAt: close, drawAt: close });
  const plan = firstWavePlan(total);
  for (const [cashKobo, quantity] of plan.instant) {
    await cycles.addPrizeTier(ctx, m, id, { stage: "INSTANT", kind: "CASH", title: `₦${(cashKobo / 100).toLocaleString("en-NG")}`, cashKobo, quantity });
  }
  let order = 0;
  for (const p of plan.draw) {
    order++;
    if (p.cashKobo) await cycles.addPrizeTier(ctx, m, id, { stage: "FINAL_DRAW", kind: "CASH", title: p.title, cashKobo: p.cashKobo, quantity: p.quantity, drawOrder: order });
    else await cycles.addPrizeTier(ctx, m, id, { stage: "FINAL_DRAW", kind: "MERCHANDISE", title: p.title, skuId: await sku(p.title, p.valueKobo!, p.stock!, p.serialised), quantity: p.quantity, drawOrder: order });
  }
  const cashTotal = plan.instant.reduce((s, [c, q]) => s + c * q, 0) + plan.draw.reduce((s, p) => s + (p.cashKobo ?? 0) * p.quantity, 0);
  await cycles.setEvidence(ctx, m, id, { financialModelRef: "demo-model", rulesDocumentRef: "demo-rules", rulesText: "Demo rules", escrowReference: "DEMO-ESCROW", escrowFundedKobo: cashTotal, auditorAdminId: admins.auditor!.id });
  await inventory.reserveStock(ctx, f, id);
  await cycles.submitCycle(ctx, m, id);
  await cycles.approveCycle(ctx, admins.operations!, id);
  await cycles.approveCycle(ctx, admins.finance!, id);
  await cycles.commitCycle(ctx, m, id);
  await cycles.openCycle(ctx, m, id);
  return { cycleId: id, admins };
}

if (process.argv[1]?.endsWith("seed-demo.ts")) {
  assertSimulationAcknowledged(process.env, "127.0.0.1");
  const config = loadConfig();
  await migrate(config.databaseUrl);
  const pool = createPool(config.databaseUrl);
  const ctx: Ctx = { pool, config, keys: new LocalKeyService(config.masterKey), beacon: new SimulatedBeacon(pool, config.beaconPeriodSeconds), messenger: new SimulatedMessenger() };
  // --first-wave seeds the full 400,000-card season (takes a while); the default demo is smaller.
  const { cycleId } = await seedDemo(ctx, process.argv.includes("--first-wave") ? { name: "Season 1 — First Wave", tickets: FIRST_WAVE_TICKETS } : {});
  console.log(`Demo cycle ${cycleId} is open. Admin sign-in emails: <role>@demo.wiifarm.test`);
  await pool.end();
}
