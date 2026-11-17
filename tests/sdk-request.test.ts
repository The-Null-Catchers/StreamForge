import assert from "node:assert/strict";
import { test } from "node:test";
import { StreamForge } from "../packages/sdk/src/index.js";

const client = new StreamForge({
  baseUrl: "https://api.example.test",
  apiKey: "default-token",
});

const headerCases: Array<[string, HeadersInit]> = [
  ["object", { "x-workspace-id": "workspace" }],
  ["Headers", new Headers({ "x-workspace-id": "workspace" })],
  ["tuples", [["x-workspace-id", "workspace"]]],
];
for (const [name, headers] of headerCases) {
  test(`preserves ${name} headers alongside SDK defaults`, async (t) => {
    t.mock.method(
      globalThis,
      "fetch",
      async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
        assert.ok(init);
        const actual = new Headers(init.headers);
        assert.equal(actual.get("x-workspace-id"), "workspace");
        assert.equal(actual.get("authorization"), "Bearer default-token");
        assert.equal(actual.get("content-type"), "application/json");
        return Response.json({ ok: true });
      },
    );
    assert.deepEqual(
      await client.request("/test", { headers, method: "POST", body: "{}" }),
      { ok: true },
    );
  });
}

test("caller headers override defaults case-insensitively", async (t) => {
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      assert.ok(init);
      const headers = new Headers(init.headers);
      assert.equal(headers.get("authorization"), "Bearer override");
      assert.equal(headers.get("content-type"), "application/problem+json");
      return Response.json({ ok: true });
    },
  );
  await client.request("/test", {
    method: "POST",
    body: "{}",
    headers: {
      authorization: "Bearer override",
      "content-type": "application/problem+json",
    },
  });
});

test("successful no-content responses do not cause JSON parse failures", async (t) => {
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      assert.ok(init);
      assert.equal(init.method, "DELETE");
      return new Response(null, { status: 204 });
    },
  );
  assert.equal(
    await client.request("/messages/id/bookmark", { method: "DELETE" }),
    undefined,
  );
});

test("JSON responses and request bodies are preserved", async (t) => {
  t.mock.method(
    globalThis,
    "fetch",
    async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      assert.ok(init);
      assert.equal(url, "https://api.example.test/api/v1/test");
      assert.equal(init.method, "POST");
      assert.equal(init.body, '{"name":"test"}');
      return Response.json({ id: "created" });
    },
  );
  assert.deepEqual(
    await client.request("/test", { method: "POST", body: '{"name":"test"}' }),
    { id: "created" },
  );
});

test("structured API failures preserve their code and message", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    Response.json(
      {
        error: {
          code: "FORBIDDEN",
          message: "Access denied",
          requestId: "req-1",
        },
      },
      { status: 403 },
    ),
  );
  await assert.rejects(
    client.request("/test"),
    (error) =>
      error instanceof Error && error.message === "FORBIDDEN: Access denied",
  );
});
