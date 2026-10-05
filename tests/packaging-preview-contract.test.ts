import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("HLS packaging requires poster, preview index, and first sprite sheet", async () => {
  const source = await readFile("apps/worker/src/pipeline.ts", "utf8");

  assert.match(source, /"thumbnails\/poster\.jpg"/);
  assert.match(source, /"thumbnails\/previews\.vtt"/);
  assert.match(source, /"thumbnails\/0001\.jpg"/);
  assert.match(source, /throw Error\("OUTPUT_MISSING"\)/);
});
