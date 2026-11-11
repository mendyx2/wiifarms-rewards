import pg from "pg";

// bigint columns hold kobo and counters; all fit comfortably in a JS safe integer.
pg.types.setTypeParser(20, (v: string) => {
  const n = Number(v);
  if (!Number.isSafeInteger(n)) throw new Error("bigint value exceeds safe integer range");
  return n;
});

export type Db = pg.PoolClient;
export type Pool = pg.Pool;

export function createPool(databaseUrl: string): Pool {
  return new pg.Pool({ connectionString: databaseUrl, max: 20 });
}

const RETRYABLE = new Set(["40P01", "40001"]); // deadlock detected, serialization failure

/**
 * Runs fn inside one database transaction. Any error rolls everything back.
 * If the database had to abort the transaction to break a deadlock, the whole
 * transaction is run again from the start (nothing from the failed attempt
 * was kept), up to three times.
 */
export async function withTx<T>(pool: Pool, fn: (db: Db) => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const db = await pool.connect();
    try {
      await db.query("BEGIN");
      const result = await fn(db);
      await db.query("COMMIT");
      return result;
    } catch (err) {
      await db.query("ROLLBACK").catch(() => {});
      const code = (err as { code?: string }).code;
      if (attempt >= 3 || !code || !RETRYABLE.has(code)) throw err;
    } finally {
      db.release();
    }
  }
}

/** Serialises work for one key (e.g. one player) for the rest of the transaction. */
export async function lockKey(db: Db, key: string): Promise<void> {
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [key]);
}

export async function one<T extends pg.QueryResultRow>(db: Db | Pool, sql: string, params: unknown[] = []): Promise<T | undefined> {
  const r = await db.query<T>(sql, params);
  return r.rows[0];
}
