import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("storage exposes real S3 multipart primitives", async () => {
  const source = await readFile("packages/shared/src/storage.ts", "utf8");
  assert.match(source, /CreateMultipartUploadCommand/);
  assert.match(source, /UploadPartCommand/);
  assert.match(source, /CompleteMultipartUploadCommand/);
  assert.match(source, /AbortMultipartUploadCommand/);
  assert.match(source, /signMultipartPart/);
});

test("direct upload API creates, signs, completes and cancels multipart uploads", async () => {
  const source = await readFile("apps/api/src/uploads.ts", "utf8");
  assert.match(source, /\/api\/v1\/uploads\/direct/);
  assert.match(source, /\/direct\/parts\/:part\/sign/);
  assert.match(source, /\/direct\/complete/);
  assert.match(source, /partNumberBase: 1/);
  assert.match(source, /MULTIPART_PARTS_INCOMPLETE/);
  assert.match(source, /MONTHLY_UPLOAD_QUOTA_EXCEEDED/);
  assert.match(source, /abortMultipart/);
});

test("direct uploads keep end-to-end SHA integrity through media probe", async () => {
  const migration = await readFile(
    "infra/migrations/025_direct_upload_pipeline_bridge.sql",
    "utf8",
  );
  const pipeline = await readFile("apps/worker/src/pipeline.ts", "utf8");
  assert.match(migration, /NEW\.upload_mode = 'direct'/);
  assert.match(migration, /NEW\.object_key/);
  assert.match(migration, /NEW\.checksum/);
  assert.match(pipeline, /digest\.digest\("hex"\) !== u\.checksum/);
  assert.match(pipeline, /partHash\.digest\("hex"\) !== part\.checksum/);
});
