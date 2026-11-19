import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveWebhookDestination } from "../apps/worker/src/webhook-destination.js";

const endpoint = new URL("https://receiver.example/webhook");
const allowedHosts = [endpoint.hostname];
const firstAddress = { address: "93.184.216.34", family: 4 };
const secondAddress = { address: "2606:4700:4700::1111", family: 6 };

test("webhook destinations require HTTPS and an exact allowlisted hostname before DNS", async () => {
  const resolve = async () => {
    assert.fail("disallowed destinations must be rejected before DNS");
  };

  for (const url of [
    new URL("http://receiver.example/webhook"),
    new URL("https://other.example/webhook"),
    new URL("https://sub.receiver.example/webhook"),
  ]) {
    await assert.rejects(
      resolveWebhookDestination(url, allowedHosts, resolve),
      { message: "WEBHOOK_HOST_NOT_ALLOWED" },
    );
  }
});

test("webhook destinations reject empty or non-public DNS results", async () => {
  for (const addresses of [
    [],
    [{ address: "127.0.0.1", family: 4 }],
    [firstAddress, { address: "::1", family: 6 }],
  ]) {
    await assert.rejects(
      resolveWebhookDestination(endpoint, allowedHosts, async () => addresses),
      { message: "WEBHOOK_PRIVATE_ADDRESS" },
    );
  }
});

test("webhook destinations select an address from the validated resolution", async () => {
  assert.deepEqual(
    await resolveWebhookDestination(endpoint, allowedHosts, async (hostname) => {
      assert.equal(hostname, endpoint.hostname);
      return [firstAddress, secondAddress];
    }),
    firstAddress,
  );
});
