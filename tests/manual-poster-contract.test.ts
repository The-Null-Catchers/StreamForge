import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("manual poster requests enqueue a dedicated media job", async () => {
  const source = await readFile("apps/api/src/poster.ts", "utf8");
  assert.match(source, /\/api\/v1\/videos\/:id\/poster/);
  assert.match(source, /timeSeconds/);
  assert.match(source, /enqueue\(client, "poster-generation"/);
  assert.match(source, /VIDEO_NOT_READY/);
  assert.match(source, /POSTER_TIME_OUT_OF_RANGE/);
});

test("poster generation extracts one frame and replaces the poster object", async () => {
  const pipeline = await readFile("apps/worker/src/pipeline.ts", "utf8");
  const media = await readFile("packages/media-core/src/poster.ts", "utf8");
  assert.match(pipeline, /job\.queueName === "poster-generation"/);
  assert.match(pipeline, /posterFrame/);
  assert.match(pipeline, /replacePosterObject/);
  assert.match(media, /export async function posterFrame/);
  assert.match(media, /"-frames:v",\s*"1"/);
  assert.match(media, /poster\.jpg/);
});

test("poster generation is a registered queue", async () => {
  const queues = await readFile("packages/shared/src/queue-names.ts", "utf8");
  assert.match(queues, /"poster-generation"/);
});
