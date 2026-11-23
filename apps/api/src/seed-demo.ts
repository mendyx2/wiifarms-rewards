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
  const { id } = await cycles.createCycle(ctx, m, {
    name: opts.name ?? "Harvest Cycle 1", ticketPriceKobo: 20_000, totalTickets: opts.tickets ?? 500, maxTicketsPerAccount: 50,
    salesOpenAt: new Date(now - 1000).toISOString(), salesCloseAt: close, drawAt: close });
  const total = opts.tickets ?? 500;
  const share = (per500: number) => Math.max(1, Math.round((per500 * total) / 500));
  const instant: [number, number][] = [[1_000_000, share(1)], [500_000, share(2)], [200_000, share(5)], [100_000, share(12)], [50_000, share(35)]];
  for (const [cashKobo, quantity] of instant) {
    await cycles.addPrizeTier(ctx, m, id, { stage: "INSTANT", kind: "CASH", title: `₦${(cashKobo / 100).toLocaleString("en-NG")}`, cashKobo, quantity });
  }
  await cycles.addPrizeTier(ctx, m, id, { stage: "FINAL_DRAW", kind: "MERCHANDISE", title: "Electric motorcycle", skuId: await sku("Electric motorcycle", 150_000_000, 1, true), quantity: 1, drawOrder: 1 });
  await cycles.addPrizeTier(ctx, m, id, { stage: "FINAL_DRAW", kind: "CASH", title: "₦100,000 cash", cashKobo: 10_000_000, quantity: 1, drawOrder: 2 });
  await cycles.addPrizeTier(ctx, m, id, { stage: "FINAL_DRAW", kind: "MERCHANDISE", title: "Solar freezer 200L", skuId: await sku("Solar freezer 200L", 55_000_000, 3, true), quantity: 2, drawOrder: 3 });
  await cycles.addPrizeTier(ctx, m, id, { stage: "FINAL_DRAW", kind: "MERCHANDISE", title: "NaijaSweetRice 50kg", skuId: await sku("NaijaSweetRice 50kg", 7_500_000, 8), quantity: 5, drawOrder: 4 });
  const cashTotal = instant.reduce((s, [c, q]) => s + c * q, 0) + 10_000_000;
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
  const { cycleId } = await seedDemo(ctx);
  console.log(`Demo cycle ${cycleId} is open. Admin sign-in emails: <role>@demo.wiifarm.test`);
  await pool.end();
}
