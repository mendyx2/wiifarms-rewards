import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import pg from "pg";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../db");

/** Applies db/schema.sql and then db/migrations/*.sql in name order, each once. */
export async function migrate(databaseUrl: string): Promise<string[]> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  const applied: string[] = [];
  try {
    await client.query("CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
    const files = ["schema.sql", ...(await readdir(path.join(root, "migrations"))).filter((f) => f.endsWith(".sql")).sort().map((f) => `migrations/${f}`)];
    for (const name of files) {
      const done = await client.query("SELECT 1 FROM schema_migrations WHERE name = $1", [name]);
      if (done.rowCount) continue;
      await client.query(await readFile(path.join(root, name), "utf8"));
      await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [name]);
      applied.push(name);
    }
  } finally {
    await client.end();
  }
  return applied;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set");
  const applied = await migrate(url);
  console.log(applied.length ? `applied: ${applied.join(", ")}` : "database is up to date");
}
