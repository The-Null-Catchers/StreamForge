import pg from "pg";
import { config } from "../../config/src/index.js";
export const db = new pg.Pool({
  connectionString: config.DATABASE_URL,
  max: 20,
});
export async function transaction<T>(
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const c = await db.connect();
  try {
    await c.query("BEGIN");
    const r = await fn(c);
    await c.query("COMMIT");
    return r;
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}
