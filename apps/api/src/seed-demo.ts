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

/**
 * The inaugural campaign as set out in the SRS (WRL/SRS/2026/001, section 2):
 * 2,686,000 cards at ₦500 (₦1,343,000,000 at sell-out), ₦20,000,000 of instant
 * cash in 18,400 prizes (about 1 in 146), and the Mega Draw list. Household
 * appliances are a placeholder (₦20m, quantities to be decided). As listed the
 * prizes total ₦591.5m; the SRS states ₦671.5m — to be reconciled by the board.
 */
export const INAUGURAL = {
  name: "WRL-2027-001 Inaugural Rewards Campaign",
  tickets: 2_686_000,
  instant: [[50_000, 10_000], [100_000, 5_000], [200_000, 2_500], [500_000, 800], [1_000_000, 100]] as [number, number][],
  draw: [
    { title: "Chinese SUV", quantity: 1, valueKobo: 3_000_000_000, stock: 1, serialised: true },
    { title: "Household appliance (to be confirmed)", quantity: 40, valueKobo: 50_000_000, stock: 40, serialised: true },
    { title: "NaijaSweetRice 50kg", quantity: 500, valueKobo: 6_500_000, stock: 500, serialised: false },
    { title: "NaijaSweetRice 25kg", quantity: 500, valueKobo: 3_300_000, stock: 500, serialised: false },
    { title: "NaijaSweetRice 5kg", quantity: 1_000, valueKobo: 750_000, stock: 1_000, serialised: false },
    { title: "NaijaSweetRice 1kg", quantity: 7_500, valueKobo: 200_000, stock: 7_500, serialised: false },
    { title: "VitaActive 50g × 10", quantity: 10_000, valueKobo: 2_000_000, stock: 10_000, serialised: false },
    { title: "VitaForce 10g × 10", quantity: 10_000, valueKobo: 2_500_000, stock: 10_000, serialised: false },
  ] as { title: string; quantity: number; cashKobo?: number; valueKobo?: number; stock?: number; serialised: boolean }[],
};
export const SEASON_DAYS = 90;
const DEMO_TICKETS = 20_000;

/**
 * The first-wave prize plan, scaled to a season of `total` cards. Prize money is
 * 50% of full sell-out sales and instant cash 5% of that (company policy).
 * At 400,000 cards the instant table below is exactly the ₦5,000,000 of instant
 * cash: by value 8% in ₦10,000 prizes, 10% in ₦5,000, 14% in ₦2,500, 28% in
 * ₦1,000 and 40% in ₦500 — 5,820 winning cards, about one in 69. Smaller demo
 * seasons get the same table scaled down (rounded down, so it never exceeds the
 * budget). Mega Draw prizes are a placeholder until the
 * real list (with images) is supplied: one car, then other prizes while they
 * fit the Mega Draw budget.
 */
export function firstWavePlan(total: number): {
  instant: [number, number][];
  draw: { title: string; quantity: number; cashKobo?: number; valueKobo?: number; stock?: number; serialised: boolean }[];
} {
  const perWave: [number, number][] = [[1_000_000, 40], [500_000, 100], [250_000, 280], [100_000, 1_400], [50_000, 4_000]];
  const instant = perWave.map(([c, q]) => [c, Math.floor((q * total) / FIRST_WAVE_TICKETS)] as [number, number]).filter(([, q]) => q > 0);
  if (!instant.length) instant.push([50_000, 1]);
  const drawBudget = Math.floor(total * TICKET_PRICE_KOBO * 0.5) - Math.floor(total * TICKET_PRICE_KOBO * 0.5 * 0.05);
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

export async function seedDemo(ctx: Ctx, opts: { name?: string; tickets?: number; closeInMinutes?: number; instant?: [number, number][]; levels?: number; inaugural?: boolean } = {}): Promise<{ cycleId: string; admins: Record<string, Admin> }> {
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
  // A demo collection centre (registered by Fulfilment, approved by Compliance) and a member of its staff,
  // who signs in as stockist@demo.wiifarm.test and sees only the stockist portal.
  const centre = (await ctx.pool.query<{ id: string }>("SELECT id FROM stockists WHERE name = 'Minna Central Stockist' LIMIT 1")).rows[0]?.id
    ?? (await ctx.pool.query<{ id: string }>(
      `INSERT INTO stockists (code, name, tier, state_code, area, address, phone, coverage, opening_hours, fee_kobo, status, registered_by, approved_by)
       VALUES ('STK-' || lpad(nextval('stockist_code_seq')::text, 4, '0'), 'Minna Central Stockist', 'MEGA', 'NG-NI', 'Minna', 'Plot 4, Paiko Road, Minna', '08030001111',
               ARRAY['Chanchaga','Bosso'], 'Mon–Sat 8am–6pm', 100000, 'ACTIVE', $1, $2) RETURNING id`, [admins.fulfilment!.id, admins.compliance!.id])).rows[0]!.id;
  const clerk = (await ctx.pool.query<{ id: string }>(
    `INSERT INTO admin_users (email, full_name, stockist_id) VALUES ('stockist@demo.wiifarm.test', 'Demo stockist', $1)
     ON CONFLICT (email) DO UPDATE SET stockist_id = EXCLUDED.stockist_id RETURNING id`, [centre])).rows[0]!.id;
  await ctx.pool.query("INSERT INTO admin_roles (admin_user_id, role, granted_by) VALUES ($1, 'STOCKIST', $2) ON CONFLICT DO NOTHING", [clerk, admins.security!.id]);

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
        ...(serialised ? { serialNumbers: Array.from({ length: units }, (_, i) => `SN-${tag}-${name.slice(0, 3).toUpperCase()}-${i + 1}`) } : { quantity: Math.min(units, 5_000) }),
        acquisitionCostKobo: Math.round(valueKobo * 0.7), landedCostKobo: Math.round(valueKobo * 0.78) });
      // A delivery records at most 5,000 units; larger stock arrives as several deliveries.
      for (let got = Math.min(units, 5_000), n = 2; !serialised && got < units; got += 5_000, n++) {
        await inventory.receiveStock(ctx, f, { skuId: id, supplierId: supplier.id, warehouseId: warehouse.id, poReference: `PO-${tag}-${name.slice(0, 5)}-${n}`,
          quantity: Math.min(5_000, units - got), acquisitionCostKobo: Math.round(valueKobo * 0.7), landedCostKobo: Math.round(valueKobo * 0.78) });
      }
    }
    return id;
  };

  // A season runs 90 days; the Mega Draw is at its end.
  const now = Date.now(), close = new Date(now + (opts.closeInMinutes ?? SEASON_DAYS * 24 * 60) * 60_000).toISOString();
  const m = admins.manager!;
  const total = opts.inaugural ? INAUGURAL.tickets : opts.tickets ?? DEMO_TICKETS;
  const { id } = await cycles.createCycle(ctx, m, {
    name: opts.name ?? (opts.inaugural ? INAUGURAL.name : "Harvest Cycle 1"), ticketPriceKobo: TICKET_PRICE_KOBO, totalTickets: total, maxTicketsPerAccount: opts.inaugural ? 900 : 200,
    salesOpenAt: new Date(now - 1000).toISOString(), salesCloseAt: close, drawAt: close,
    // The instant cash is released in 4 levels as cards sell (each level holds a quarter of every prize).
    levels: opts.levels ?? (total % 4 === 0 ? 4 : 1) });
  const plan = opts.inaugural ? { instant: INAUGURAL.instant, draw: INAUGURAL.draw } : firstWavePlan(total);
  if (opts.instant) { plan.instant = opts.instant; plan.draw = []; } // a custom instant table (tests)
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
  // --inaugural seeds the SRS inaugural campaign (2,686,000 cards; takes a few minutes).
  const { cycleId } = await seedDemo(ctx, process.argv.includes("--inaugural") ? { inaugural: true }
    : process.argv.includes("--first-wave") ? { name: "Season 1 — First Wave", tickets: FIRST_WAVE_TICKETS } : {});
  console.log(`Demo cycle ${cycleId} is open. Admin sign-in emails: <role>@demo.wiifarm.test`);
  await pool.end();
}
