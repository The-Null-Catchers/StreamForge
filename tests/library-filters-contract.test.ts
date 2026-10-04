import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../apps/api/src/videos.ts", import.meta.url), "utf8");

test("library video list exposes date duration resolution privacy and sorting filters", () => {
  for (const field of [
    "privacy",
    "createdAfter",
    "createdBefore",
    "minDuration",
    "maxDuration",
    "minHeight",
    "maxHeight",
  ])
    assert.match(source, new RegExp(field));

  assert.match(source, /metadata->>'duration'/);
  assert.match(source, /metadata->>'height'/);
  assert.match(source, /created_at >= \$5/);
  assert.match(source, /created_at <= \$6/);
  assert.match(source, /sort: z[\s\S]*latest[\s\S]*oldest[\s\S]*duration[\s\S]*size/);
});

test("library range filters reject inverted ranges", () => {
  assert.match(source, /minDuration > value\.maxDuration/);
  assert.match(source, /minHeight > value\.maxHeight/);
  assert.match(source, /createdAfter[\s\S]*createdBefore[\s\S]*new Date\(value\.createdAfter\) > new Date\(value\.createdBefore\)/);
});
