import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("tus routes expose creation, resume, patch and termination semantics", async () => {
  const source = await readFile("apps/api/src/tus.ts", "utf8");
  assert.match(source, /TUS_VERSION = "1\.0\.0"/);
  assert.match(source, /Tus-Extension.*creation,termination/s);
  assert.match(source, /app\.post\("\/api\/v1\/tus"/);
  assert.match(source, /app\.head<.*\/api\/v1\/tus\/:id/s);
  assert.match(source, /app\.patch<.*\/api\/v1\/tus\/:id/s);
  assert.match(source, /app\.delete<.*\/api\/v1\/tus\/:id/s);
  assert.match(source, /Upload-Offset/);
  assert.match(source, /Upload-Length/);
  assert.match(source, /application\/offset\+octet-stream/);
});

test("tus chunks preserve quotas, durable processing and integrity verification", async () => {
  const source = await readFile("apps/api/src/tus.ts", "utf8");
  const pipeline = await readFile("apps/worker/src/pipeline.ts", "utf8");
  assert.match(source, /STORAGE_QUOTA_EXCEEDED/);
  assert.match(source, /MONTHLY_UPLOAD_QUOTA_EXCEEDED/);
  assert.match(source, /expectedPartSize/);
  assert.match(source, /hash\(body\)/);
  assert.match(source, /enqueue\(c, "media-probe"/);
  assert.match(pipeline, /digest\.digest\("hex"\) !== u\.checksum/);
});

test("platform registers tus routes", async () => {
  const source = await readFile("apps/api/src/platform.ts", "utf8");
  assert.match(source, /import \{ tusRoutes \} from "\.\/tus\.js"/);
  assert.match(source, /await tusRoutes\(app\)/);
});
