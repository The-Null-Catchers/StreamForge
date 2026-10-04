import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("sprite generator emits compact WebVTT xywh previews", async () => {
  const source = await readFile("packages/media-core/src/sprites.ts", "utf8");
  assert.match(source, /tile=\$\{COLUMNS\}x\$\{ROWS\}/);
  assert.match(source, /#xywh=\$\{x\},\$\{y\},\$\{TILE_WIDTH\},\$\{TILE_HEIGHT\}/);
  assert.match(source, /MAX_FRAMES = 60/);
  assert.match(source, /FRAMES_PER_SHEET = COLUMNS \* ROWS/);
  assert.match(source, /previews\.vtt/);
  assert.match(source, /poster\.jpg/);
});

test("sprite cells use fixed dimensions for predictable player cropping", async () => {
  const source = await readFile("packages/media-core/src/sprites.ts", "utf8");
  assert.match(source, /TILE_WIDTH = 240/);
  assert.match(source, /TILE_HEIGHT = 135/);
  assert.match(source, /force_original_aspect_ratio=decrease/);
  assert.match(source, /pad=\$\{TILE_WIDTH\}:\$\{TILE_HEIGHT\}/);
});
