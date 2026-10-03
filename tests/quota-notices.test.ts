import test from "node:test";
import assert from "node:assert/strict";
import { crossedThresholds } from "../apps/worker/src/quota-thresholds.js";

test("quota thresholds are emitted only after crossing their levels", () => {
  assert.deepEqual(crossedThresholds(79, 100), []);
  assert.deepEqual(crossedThresholds(80, 100), [80]);
  assert.deepEqual(crossedThresholds(91, 100), [80, 90]);
  assert.deepEqual(crossedThresholds(100, 100), [80, 90, 100]);
  assert.deepEqual(crossedThresholds(150, 100), [80, 90, 100]);
});

test("zero quotas warn only when usage exists", () => {
  assert.deepEqual(crossedThresholds(0, 0), []);
  assert.deepEqual(crossedThresholds(1, 0), [80, 90, 100]);
});
