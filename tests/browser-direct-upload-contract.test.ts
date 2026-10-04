import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("browser direct upload persists multipart progress and resumes", async () => {
  const source = await readFile("apps/web/lib/upload.ts", "utf8");
  assert.match(source, /sf_direct_upload_/);
  assert.match(source, /localStorage\.setItem\(key, JSON\.stringify\(manifest\)\)/);
  assert.match(source, /\/uploads\/\$\{manifest\.uploadId\}\/direct\/parts\/\$\{partNumber\}\/sign/);
  assert.match(source, /response\?\.headers\.get\("etag"\)/);
  assert.match(source, /\/direct\/complete/);
});

test("upload page prefers direct storage but preserves proxy compatibility", async () => {
  const source = await readFile("apps/web/app/upload/page.tsx", "utf8");
  assert.match(source, /useState<UploadMode>\("direct"\)/);
  assert.match(source, /Direct to storage · recommended/);
  assert.match(source, /Through StreamForge API · compatibility/);
  assert.match(source, /mode === "direct" \? uploadDirect : upload/);
  assert.match(source, /page reload on this browser/);
});
