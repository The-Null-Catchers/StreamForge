import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("S3 storage inventories complete prefixes with object sizes", async () => {
  const source = await readFile("packages/shared/src/storage.ts", "utf8");
  assert.match(source, /async listPrefix\(prefix: string\)/);
  assert.match(source, /ListObjectsV2Command/);
  assert.match(source, /ContinuationToken: token/);
  assert.match(source, /size: Number\(object\.Size \?\? 0\)/);
  assert.match(source, /token = r\.NextContinuationToken/);
});

test("maintenance reconciles output accounting against stored objects", async () => {
  const source = await readFile("apps/worker/src/usage-reconcile.ts", "utf8");
  assert.match(source, /reconcileObjectStoreOutputUsage\(objectStoreCursor\)/);
  assert.match(source, /storage\.listPrefix\(video\.output_prefix\)/);
  assert.match(source, /actualBytes = objects\.reduce/);
  assert.match(source, /SELECT output_bytes FROM videos WHERE id=\$1 AND deleted_at IS NULL FOR UPDATE/);
  assert.match(source, /object-store-reconcile:/);
  assert.match(source, /UPDATE videos SET output_bytes=\$1/);
  assert.match(source, /status IN \('ready','failed'\)/);
});
