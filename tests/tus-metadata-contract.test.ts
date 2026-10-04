import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("tus creation requires StreamForge media metadata and total checksum", async () => {
  const source = await readFile("apps/api/src/tus.ts", "utf8");
  for (const field of ["workspaceId", "videoId", "filename", "mimeType", "checksum"])
    assert.match(source, new RegExp(`${field}:`));
  assert.match(source, /Upload-Metadata|upload-metadata/);
  assert.match(source, /upload-length/);
  assert.match(source, /video\.upload\.started/);
});
