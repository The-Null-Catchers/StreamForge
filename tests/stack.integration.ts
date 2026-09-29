import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db } from "../packages/shared/src/db.js";
import { hash } from "../packages/shared/src/security.js";
import { run } from "../packages/media-core/src/index.js";
const base = process.env.TEST_API_URL ?? "http://localhost:4000";
let token = "";
async function request(
  path: string,
  method = "GET",
  body?: unknown,
  headers: Record<string, string> = {},
) {
  const r = await fetch(base + path, {
    method,
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body:
      body === undefined
        ? undefined
        : Buffer.isBuffer(body)
          ? new Uint8Array(body)
          : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
}
after(async () => {
  await db.end();
});
test(
  "account → resumable upload → worker → signed playback → subtitles → analytics → API key",
  { timeout: 240000 },
  async () => {
    const email = `test-${randomUUID()}@example.test`;
    const password = "Long-test-password-927!";
    const registration = await request("/api/v1/auth/register", "POST", {
      email,
      password,
    });
    assert.equal(registration.status, 201, JSON.stringify(registration.body));
    assert.equal(
      (await request("/api/v1/auth/login", "POST", { email, password })).status,
      403,
    );
    // Test-only verification setup: real verification email is sent to the local Mailpit service.
    await db.query("UPDATE users SET email_verified=true WHERE email=$1", [
      email,
    ]);
    const login = await request("/api/v1/auth/login", "POST", {
      email,
      password,
    });
    assert.equal(login.status, 200);
    token = login.body.accessToken;
    const ws = (
      await request("/api/v1/workspaces", "POST", {
        name: "Integration workspace",
      })
    ).body;
    const v = (
      await request("/api/v1/videos", "POST", {
        workspaceId: ws.id,
        title: "Integration video",
      })
    ).body;
    const dir = await mkdtemp(join(tmpdir(), "sf-stack-"));
    try {
      const file = join(dir, "sample.mp4");
      await run("ffmpeg", [
        "-v",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=1280x720:rate=24",
        "-t",
        "10",
        "-c:v",
        "libx264",
        "-crf",
        "0",
        "-threads",
        "2",
        file,
      ]);
      const bytes = await readFile(file);
      const u = (
        await request("/api/v1/uploads", "POST", {
          workspaceId: ws.id,
          videoId: v.id,
          filename: "test.mp4",
          mimeType: "video/mp4",
          totalSize: bytes.length,
          checksum: hash(bytes),
        })
      ).body;
      assert.ok(
        bytes.length > u.chunk_size,
        "fixture spans multiple default-size chunks",
      );
      const first = bytes.subarray(0, u.chunk_size);
      const headers = {
        "Content-Type": "application/octet-stream",
        "X-Checksum-Sha256": hash(first),
      };
      assert.equal(
        (await request(`/api/v1/uploads/${u.id}/complete`, "POST", {})).status,
        409,
      );
      assert.equal(
        (
          await request(`/api/v1/uploads/${u.id}/parts/0`, "PUT", first, {
            ...headers,
            "X-Checksum-Sha256": "0".repeat(64),
          })
        ).status,
        422,
      );
      assert.equal(
        (
          await request(
            `/api/v1/uploads/${u.id}/parts/0`,
            "PUT",
            first,
            headers,
          )
        ).status,
        200,
      );
      // Reconnect after only the first chunk, then skip confirmed parts.
      const resumed = await request(`/api/v1/uploads/${u.id}`);
      assert.equal(Number(resumed.body.uploaded_bytes), first.length);
      assert.equal(resumed.body.parts.length, 1);
      assert.equal(
        (await request(`/api/v1/uploads/${u.id}/complete`, "POST", {})).status,
        409,
      );
      assert.equal(
        (
          await request(
            `/api/v1/uploads/${u.id}/parts/0`,
            "PUT",
            first,
            headers,
          )
        ).status,
        200,
      );
      for (
        let part = 1;
        part < Math.ceil(bytes.length / u.chunk_size);
        part++
      ) {
        const chunk = bytes.subarray(
          part * u.chunk_size,
          (part + 1) * u.chunk_size,
        );
        const result = await request(
          `/api/v1/uploads/${u.id}/parts/${part}`,
          "PUT",
          chunk,
          {
            "Content-Type": "application/octet-stream",
            "X-Checksum-Sha256": hash(chunk),
          },
        );
        assert.equal(result.status, 200, JSON.stringify(result.body));
      }
      assert.equal(
        (await request(`/api/v1/uploads/${u.id}/complete`, "POST", {})).status,
        200,
      );
      let ready = false;
      for (let i = 0; i < 100; i++) {
        const current = (await request(`/api/v1/videos/${v.id}`)).body;
        assert.notEqual(current.status, "failed", JSON.stringify(current));
        if (current.status === "ready") {
          ready = true;
          assert.equal(current.renditions.length, 3);
          break;
        }
        await new Promise((r) => setTimeout(r, 1500));
      }
      assert.ok(ready, "video became ready");
      const readyRow = (
        await db.query(
          "SELECT * FROM videos WHERE id=$1",
          [v.id],
        )
      ).rows[0];
      const replacementId = randomUUID();
      await db.query(
        `INSERT INTO videos(
           id,workspace_id,title,description,tags,filename,privacy,status,progress,
           metadata,renditions,source_key,output_prefix,checksum,size,created_at,updated_at
         ) VALUES($1,$2,$3,'','{}',$4,'private','ready','{}',$5,$6,$7,$8,$9,$10,now(),now())`,
        [
          replacementId,
          ws.id,
          "Replacement source",
          readyRow.filename,
          JSON.stringify(readyRow.metadata),
          JSON.stringify(readyRow.renditions),
          readyRow.source_key,
          readyRow.output_prefix,
          readyRow.checksum,
          readyRow.size,
        ],
      );

      const versionCreate = await request(
        `/api/v1/videos/${v.id}/versions`,
        "POST",
        { sourceVideoId: replacementId, label: "Client revision" },
      );
      assert.equal(versionCreate.status, 201, JSON.stringify(versionCreate.body));
      assert.equal(versionCreate.body.version_number, 2);
      const versions = await request(`/api/v1/videos/${v.id}/versions`);
      assert.equal(versions.status, 200);
      assert.equal(versions.body.length, 2);
      const baseline = versions.body.find((x: any) => x.version_number === 1);
      assert.ok(baseline?.active);
      assert.equal(
        (
          await request(
            `/api/v1/videos/${v.id}/versions/${versionCreate.body.id}/activate`,
            "PUT",
            {},
          )
        ).status,
        200,
      );
      const activatedVersions = await request(`/api/v1/videos/${v.id}/versions`);
      assert.equal(
        activatedVersions.body.find((x: any) => x.id === versionCreate.body.id)?.active,
        true,
      );
      assert.equal(
        (await request(`/api/v1/videos/${replacementId}`, "DELETE")).status,
        409,
      );
      assert.equal(
        (
          await request(
            `/api/v1/videos/${v.id}/versions/${versionCreate.body.id}`,
            "DELETE",
          )
        ).status,
        409,
      );
      assert.equal(
        (
          await request(
            `/api/v1/videos/${v.id}/versions/${baseline.id}/activate`,
            "PUT",
            {},
          )
        ).status,
        200,
      );
      assert.equal(
        (
          await request(
            `/api/v1/videos/${v.id}/versions/${versionCreate.body.id}`,
            "DELETE",
          )
        ).status,
        200,
      );

      const reviewComment = await request(
        `/api/v1/videos/${v.id}/review-comments`,
        "POST",
        { timestampSeconds: 2.5, body: "Tighten this transition." },
      );
      assert.equal(reviewComment.status, 201, JSON.stringify(reviewComment.body));
      const replyComment = await request(
        `/api/v1/videos/${v.id}/review-comments`,
        "POST",
        {
          parentId: reviewComment.body.id,
          versionId: baseline.id,
          timestampSeconds: 2.5,
          body: "Updated in the next cut.",
        },
      );
      assert.equal(replyComment.status, 201, JSON.stringify(replyComment.body));
      assert.equal(
        (
          await request(
            `/api/v1/videos/${v.id}/review-comments/${reviewComment.body.id}`,
            "PATCH",
            { resolved: true },
          )
        ).status,
        200,
      );
      const comments = await request(`/api/v1/videos/${v.id}/review-comments`);
      assert.equal(comments.body.length, 2);
      assert.ok(
        comments.body.find((x: any) => x.id === reviewComment.body.id)?.resolved_at,
      );
      assert.equal(
        (
          await request(`/api/v1/videos/${v.id}/review-status`, "PUT", {
            status: "changes_requested",
          })
        ).status,
        200,
      );
      assert.equal(
        (await request(`/api/v1/videos/${v.id}`)).body.review_status,
        "changes_requested",
      );

      const playback = (await request(`/api/v1/videos/${v.id}/playback`)).body;
      const masterPath =
        new URL(playback.url).pathname + new URL(playback.url).search;
      assert.equal(
        (await fetch(base + new URL(playback.url).pathname)).status,
        401,
      );
      const master = await fetch(base + masterPath);
      assert.equal(master.status, 200);
      const text = await master.text();
      assert.match(text, /#EXTM3U/);
      const variant = text.split("\n").find((x) => x.startsWith("360p/"))!;
      assert.ok(variant.includes("token="));
      const variantUrl = new URL(variant, base + masterPath);
      const playlist = await (await fetch(variantUrl)).text();
      const segment = playlist
        .split("\n")
        .find((x) => x.startsWith("segment-"))!;
      assert.equal((await fetch(new URL(segment, variantUrl))).status, 200);
      assert.equal(
        (
          await request(`/api/v1/videos/${v.id}/subtitles`, "POST", {
            language: "ar",
            label: "العربية",
            content: "1\n00:00:00,000 --> 00:00:01,000\nمرحبا",
          })
        ).status,
        200,
      );
      const chapterUpdate = await request(
        `/api/v1/videos/${v.id}/chapters`,
        "PUT",
        {
          chapters: [
            { startSeconds: 0, title: "Introduction" },
            { startSeconds: 4.5, title: "Demo" },
          ],
        },
      );
      assert.equal(chapterUpdate.status, 200, JSON.stringify(chapterUpdate.body));
      const chapterList = await request(`/api/v1/videos/${v.id}/chapters`);
      assert.equal(chapterList.status, 200);
      assert.deepEqual(
        chapterList.body.map((chapter: any) => chapter.title),
        ["Introduction", "Demo"],
      );
      assert.equal(
        (
          await request(`/api/v1/videos/${v.id}/chapters`, "PUT", {
            chapters: [
              { startSeconds: 1, title: "One" },
              { startSeconds: 1, title: "Duplicate" },
            ],
          })
        ).status,
        409,
      );

      const playlistCreated = await request("/api/v1/playlists", "POST", {
        workspaceId: ws.id,
        name: "Integration playlist",
      });
      assert.equal(
        playlistCreated.status,
        201,
        JSON.stringify(playlistCreated.body),
      );
      const playlistId = playlistCreated.body.id;
      assert.equal(
        (
          await request(`/api/v1/playlists/${playlistId}/items`, "PUT", {
            videoIds: [v.id],
          })
        ).status,
        200,
      );
      const playlistDetail = await request(
        `/api/v1/playlists/${playlistId}`,
      );
      assert.equal(playlistDetail.status, 200);
      assert.equal(playlistDetail.body.items.length, 1);
      assert.equal(playlistDetail.body.items[0].id, v.id);
      assert.equal(
        (
          await request(`/api/v1/playlists/${playlistId}/items`, "PUT", {
            videoIds: [v.id, v.id],
          })
        ).status,
        409,
      );

      await request("/api/v1/analytics/events", "POST", {
        id: randomUUID(),
        token: playback.token,
        event: "play",
        position: 0,
        startupMs: 180,
      });
      await request("/api/v1/analytics/events", "POST", {
        id: randomUUID(),
        token: playback.token,
        event: "quality_change",
        position: 1,
        quality: "720p",
      });
      await request("/api/v1/analytics/events", "POST", {
        id: randomUUID(),
        token: playback.token,
        event: "heartbeat",
        position: 5,
        watchSeconds: 5,
      });
      const analytics = await request(`/api/v1/videos/${v.id}/analytics`);
      assert.equal(Number(analytics.body.plays), 1);
      assert.equal(Number(analytics.body.unique_viewers), 1);
      assert.equal(Number(analytics.body.watch_seconds), 5);
      assert.equal(Number(analytics.body.avg_startup_ms), 180);
      assert.ok(Number(analytics.body.average_watch_percentage) > 0);
      const realtime = await request(
        `/api/v1/videos/${v.id}/analytics/realtime`,
      );
      assert.equal(Number(realtime.body.active_viewers), 1);
      assert.equal(Number(realtime.body.qualities["720p"]), 1);
      const key = (
        await request("/api/v1/api-keys", "POST", {
          workspaceId: ws.id,
          name: "read only",
          scopes: ["videos:read"],
        })
      ).body.key;
      assert.ok(key.startsWith("sf_live_"));
      const savedToken = token;
      token = key;
      assert.equal((await request(`/api/v1/videos/${v.id}`)).status, 200);
      assert.equal(
        (
          await request("/api/v1/videos", "POST", {
            workspaceId: ws.id,
            title: "Forbidden",
          })
        ).status,
        403,
      );
      token = savedToken;
      const strangerWorkspace = randomUUID();
      assert.equal(
        (await request(`/api/v1/videos?workspaceId=${strangerWorkspace}`))
          .status,
        403,
      );
      token = "";
      assert.equal(
        (await request(`/api/v1/videos/${v.id}/playback`)).status,
        401,
      );
      token = savedToken;
      const refreshed = (
        await request("/api/v1/auth/refresh", "POST", {
          refreshToken: login.body.refreshToken,
        })
      ).body;
      assert.ok(refreshed.accessToken);
      assert.equal(
        (
          await request("/api/v1/auth/refresh", "POST", {
            refreshToken: login.body.refreshToken,
          })
        ).status,
        401,
      );
      token = refreshed.accessToken;
      assert.equal((await request("/api/v1/workspaces")).status, 401);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);
