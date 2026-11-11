import { SimulatedBeacon } from "./beacon.ts";
import { loadConfig } from "./config.ts";
import type { Ctx } from "./context.ts";
import { LocalKeyService } from "./crypto.ts";
import { createPool } from "./db.ts";
import { buildServer } from "./http.ts";
import { migrate } from "./migrate.ts";
import { closeDueCycles } from "./modules/cycles.ts";

const config = loadConfig();
await migrate(config.databaseUrl);
const pool = createPool(config.databaseUrl);
const ctx: Ctx = { pool, config, keys: new LocalKeyService(config.masterKey), beacon: new SimulatedBeacon(pool, config.beaconPeriodSeconds) };

// Closes cycles that have sold out or reached their published closing time.
setInterval(() => { closeDueCycles(ctx).catch((e) => console.error("closeDueCycles failed", e)); }, 15_000).unref();

const app = buildServer(ctx);
const port = Number(process.env.PORT ?? 3000);
await app.listen({ port, host: process.env.HOST ?? "127.0.0.1" });
console.log(`WiiFarm Rewards API (SIMULATED — no real money) listening on ${port}`);
