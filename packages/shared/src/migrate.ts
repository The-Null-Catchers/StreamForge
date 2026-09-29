import { readFile, readdir } from "node:fs/promises";
import { db } from "./db.js";
const c = await db.connect();
try {
  await c.query("SELECT pg_advisory_lock(735014)");
  await c.query(
    "CREATE TABLE IF NOT EXISTS schema_migrations(name text PRIMARY KEY, applied_at timestamptz DEFAULT now())",
  );
  for (const name of (await readdir("infra/migrations"))
    .filter((x) => x.endsWith(".sql"))
    .sort()) {
    if (
      (await c.query("SELECT 1 FROM schema_migrations WHERE name=$1", [name]))
        .rowCount
    )
      continue;
    await c.query("BEGIN");
    try {
      await c.query(await readFile(`infra/migrations/${name}`, "utf8"));
      await c.query("INSERT INTO schema_migrations(name) VALUES($1)", [name]);
      await c.query("COMMIT");
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    }
  }
} finally {
  await c.query("SELECT pg_advisory_unlock(735014)");
  c.release();
  await db.end();
}
