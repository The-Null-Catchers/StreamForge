import test from "node:test";
import assert from "node:assert/strict";
import { workerQueueSelection } from "../apps/worker/src/worker-pools.js";

test("worker queue selection defaults to all queues", () => {
  const queues = workerQueueSelection("");
  assert.ok(queues.includes("media-probe"));
  assert.ok(queues.includes("webhooks"));
  assert.ok(queues.includes("cleanup"));
});

test("worker queue selection trims and deduplicates explicit pools", () => {
  assert.deepEqual(
    workerQueueSelection(" media-probe,video-transcode,media-probe "),
    ["media-probe", "video-transcode"],
  );
});

test("worker queue selection rejects unknown queues", () => {
  assert.throws(
    () => workerQueueSelection("media-probe,unknown-queue"),
    /Unknown worker queue/,
  );
});
