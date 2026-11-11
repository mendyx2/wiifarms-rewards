import { randomBytes } from "node:crypto";
import type { Pool } from "./db.ts";

/**
 * Source of public randomness for the final draw. The round to use is fixed
 * and published when the cycle is committed; its value only exists later.
 */
export interface Beacon {
  readonly source: string;
  /** First round whose value is produced strictly after the given time. */
  roundAfter(time: Date): number;
  /** Value of a round, or null if that round has not happened yet. */
  get(round: number): Promise<Buffer | null>;
}

/**
 * Simulation stand-in: rounds tick on a fixed period and each value is random,
 * created the first time it is asked for after its time has passed. It mimics
 * the timing of a public beacon but is NOT publicly verifiable — production
 * must use a real public beacon or a regulator-approved source.
 */
export class SimulatedBeacon implements Beacon {
  readonly source = "simulated-beacon";
  readonly #pool: Pool;
  readonly #periodMs: number;
  constructor(pool: Pool, periodSeconds: number) {
    this.#pool = pool;
    this.#periodMs = periodSeconds * 1000;
  }
  roundAfter(time: Date): number {
    return Math.floor(time.getTime() / this.#periodMs) + 1;
  }
  async get(round: number): Promise<Buffer | null> {
    if (round * this.#periodMs > Date.now()) return null;
    const r = await this.#pool.query<{ value: Buffer }>(
      `INSERT INTO simulated_beacon_rounds (round, value) VALUES ($1, $2)
       ON CONFLICT (round) DO NOTHING RETURNING value`,
      [round, randomBytes(32)],
    );
    if (r.rows[0]) return r.rows[0].value;
    const existing = await this.#pool.query<{ value: Buffer }>("SELECT value FROM simulated_beacon_rounds WHERE round = $1", [round]);
    return existing.rows[0]?.value ?? null;
  }
}
