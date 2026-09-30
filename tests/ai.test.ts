import { test } from "node:test";
import assert from "node:assert/strict";
import { generateMediaHelpers } from "../packages/ai/src/index.js";

test("AI media helper validates and normalizes structured results", async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                summary: "Summary",
                title: "Suggested title",
                description: "Suggested description",
                tags: ["video", "demo"],
                chapters: [
                  { startSeconds: 12, title: "Second" },
                  { startSeconds: 0, title: "Intro" },
                  { startSeconds: 9999, title: "Outside duration" },
                ],
              }),
            },
          },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  try {
    const result = await generateMediaHelpers(
      { baseUrl: "https://example.test/v1", apiKey: "test", model: "test" },
      {
        kind: "all",
        language: "en",
        transcript: "[00:00:00] Hello\n[00:00:12] Demo",
        duration: 60,
        currentTitle: "Original",
      },
    );
    assert.equal(result.title, "Suggested title");
    assert.deepEqual(
      result.chapters?.map((chapter) => chapter.startSeconds),
      [0, 12],
    );
  } finally {
    globalThis.fetch = previous;
  }
});

test("AI media helper rejects malformed provider JSON", async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        choices: [{ message: { content: "not-json" } }],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  try {
    await assert.rejects(
      () =>
        generateMediaHelpers(
          { baseUrl: "https://example.test/v1", apiKey: "test", model: "test" },
          {
            kind: "summary",
            language: "en",
            transcript: "Hello",
            duration: 10,
          },
        ),
      /AI_INVALID_JSON/,
    );
  } finally {
    globalThis.fetch = previous;
  }
});
