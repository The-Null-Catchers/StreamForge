import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("advanced library UI exposes all durable API filters", async () => {
  const source = await readFile("apps/web/app/library/page.tsx", "utf8");
  for (const key of [
    "createdAfter",
    "createdBefore",
    "minDuration",
    "maxDuration",
    "minHeight",
    "maxHeight",
    "privacy",
    "status",
    "sort",
  ]) {
    assert.match(source, new RegExp(key));
  }
  assert.match(source, /URLSearchParams/);
  assert.match(source, /\/videos\?\$\{query\}/);
});

test("library filter presets are scoped per workspace and persisted", async () => {
  const source = await readFile("apps/web/app/library/page.tsx", "utf8");
  assert.match(source, /sf_library_presets_\$\{workspaceId\}/);
  assert.match(source, /localStorage\.setItem/);
  assert.match(source, /Save preset/);
  assert.match(source, /deletePreset/);
});

test("advanced library UI supports pagination and reset", async () => {
  const source = await readFile("apps/web/app/library/page.tsx", "utf8");
  assert.match(source, /offset - 30/);
  assert.match(source, /offset \+ 30/);
  assert.match(source, /Clear filters/);
  assert.match(source, /setFilters\(emptyFilters\)/);
});
