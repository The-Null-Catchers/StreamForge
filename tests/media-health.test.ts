import { test, mock } from "node:test";
import assert from "node:assert/strict";

Object.assign(process.env, {
  DATABASE_URL: "postgresql://test:test@localhost:5432/test",
  REDIS_URL: "redis://localhost:6379",
  JWT_SECRET: "test-only-jwt-secret-12345678901234567890",
  PLAYBACK_SECRET: "test-only-playback-secret-12345678901234567890",
  S3_ENDPOINT: "http://localhost:9000",
  S3_ACCESS_KEY: "test-only",
  S3_SECRET_KEY: "test-only",
});
const { scanReadyVideoMediaHealth } =
  await import("../apps/worker/src/media-health.js");
const { db } = await import("../packages/shared/src/db.js");
const { storage } = await import("../packages/shared/src/storage.js");
const video = {
  id: "video",
  workspace_id: "workspace",
  output_prefix: "media/",
  metadata: {},
  renditions: [],
};

test("storage outages leave ready videos unchanged and remain retryable", async () => {
  const outage = new Error("object store timed out");
  const query = mock.method(db, "query", async () => ({ rows: [video] }));
  const exists = mock.method(storage, "exists", async () => {
    throw outage;
  });
  const connect = mock.method(db, "connect", async () => {
    throw new Error("must not quarantine");
  });
  try {
    await assert.rejects(
      scanReadyVideoMediaHealth(null),
      (error) => error === outage,
    );
    assert.equal(connect.mock.callCount(), 0);
  } finally {
    query.mock.restore();
    exists.mock.restore();
    connect.mock.restore();
  }
});

test("confirmed missing media is quarantined and produces one notification", async () => {
  const writes: string[] = [];
  const query = mock.method(db, "query", async () => ({ rows: [video] }));
  const exists = mock.method(storage, "exists", async () => false);
  const connect = mock.method(db, "connect", async () => ({
    query: async (sql: string) => {
      writes.push(sql);
      return { rows: [], rowCount: 1 };
    },
    release() {},
  }));
  try {
    assert.deepEqual(await scanReadyVideoMediaHealth(null), {
      checked: 1,
      unhealthy: 1,
      cursor: null,
    });
    assert.equal(
      writes.filter((sql) => sql.includes("SET status='failed'")).length,
      1,
    );
    assert.equal(
      writes.filter((sql) => sql.includes("INSERT INTO notifications")).length,
      1,
    );
    assert.ok(writes.includes("COMMIT"));
  } finally {
    query.mock.restore();
    exists.mock.restore();
    connect.mock.restore();
  }
});
