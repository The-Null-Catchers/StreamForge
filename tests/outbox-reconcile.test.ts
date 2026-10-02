import test from "node:test";
import assert from "node:assert/strict";
import { reconcileDispatchedOutbox } from "../apps/worker/src/outbox-reconcile.js";

test("outbox reconciliation restores Redis-lost jobs and acknowledges terminal jobs", async () => {
  const updates: { sql: string; values?: unknown[] }[] = [];
  const database = {
    async query(sql: string, values?: unknown[]) {
      if (sql.includes("SELECT id,queue")) {
        return {
          rows: [
            { id: "missing", queue: "media-probe" },
            { id: "active", queue: "video-transcode" },
            { id: "done", queue: "analytics" },
          ],
          rowCount: 3,
        };
      }
      updates.push({ sql, values });
      return { rows: [], rowCount: 1 };
    },
  };

  const states: Record<string, null | string> = {
    missing: null,
    active: "active",
    done: "completed",
  };
  const queue = {
    async getJob(id: string) {
      const state = states[id];
      if (!state) return null;
      return { getState: async () => state };
    },
  };

  const restored = await reconcileDispatchedOutbox(
    database,
    () => queue,
    60_000,
  );

  assert.equal(restored, 1);
  assert.equal(updates.length, 2);
  assert.match(updates[0].sql, /SET dispatched_at=NULL/);
  assert.deepEqual(updates[0].values, ["missing"]);
  assert.match(updates[1].sql, /acknowledged_at=coalesce/);
  assert.deepEqual(updates[1].values, ["done"]);
});

test("outbox reconciliation ignores unknown queues", async () => {
  const database = {
    async query(sql: string) {
      if (sql.includes("SELECT id,queue"))
        return {
          rows: [{ id: "unknown", queue: "not-a-queue" }],
          rowCount: 1,
        };
      throw new Error("unexpected update");
    },
  };

  const restored = await reconcileDispatchedOutbox(
    database,
    () => undefined,
  );
  assert.equal(restored, 0);
});
