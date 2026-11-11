import type { Beacon } from "./beacon.ts";
import type { Config } from "./config.ts";
import type { KeyService } from "./crypto.ts";
import type { Pool } from "./db.ts";

export interface Ctx {
  pool: Pool;
  config: Config;
  keys: KeyService;
  beacon: Beacon;
}
