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
    const openApiResponse = await fetch(base + "/api/openapi.json");
    assert.equal(openApiResponse.status, 200);
    const openApi = await openApiResponse.json();
    assert.equal(openApi.openapi, "3.1.0");
    assert.equal(openApi.info.version, "0.1.0");
    assert.ok(openApi.paths["/api/v1/videos"]);
    assert.ok(openApi.paths["/api/v1/live-streams"]);
    assert.ok(openApi.components.securitySchemes.bearerAuth);
    const ws = (
      await request("/api/v1/workspaces", "POST", {
        name: "Integration workspace",
      })
    ).body;
    const operations = await request(
      `/api/v1/workspaces/${ws.id}/operations`,
    );
    assert.equal(operations.status, 200, JSON.stringify(operations.body));
    assert.equal(operations.body.dependencies.database, "ok");
    assert.equal(operations.body.dependencies.redis, "ok");
    assert.equal(operations.body.dependencies.storage, "ok");
    assert.equal(operations.body.dependencies.workers, "ok");
    assert.ok(operations.body.usage);
    const liveCreated = await request("/api/v1/live-streams", "POST", {
      workspaceId: ws.id,
      name: "Integration live",
    });
    assert.equal(liveCreated.status, 201, JSON.stringify(liveCreated.body));
    assert.match(liveCreated.body.streamKey, /^sf_stream_/);
    assert.match(
      liveCreated.body.ingest.primaryRtmpStreamKey,
      new RegExp(liveCreated.body.id),
    );
    assert.match(liveCreated.body.backupStreamKey, /^sf_stream_/);

    const livePath = `live/${liveCreated.body.id}/primary`;
    const backupLivePath = `live/${liveCreated.body.id}/backup`;
    const badPublishAuth = await fetch(base + "/api/v1/live/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user: "",
        password: "",
        token: "bad-key",
        action: "publish",
        path: livePath,
        protocol: "rtmp",
        id: "integration-publisher",
        query: "",
      }),
    });
    assert.equal(badPublishAuth.status, 403);

    const goodPublishAuth = await fetch(base + "/api/v1/live/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user: "",
        password: "",
        token: liveCreated.body.streamKey,
        action: "publish",
        path: livePath,
        protocol: "rtmp",
        id: "integration-publisher",
        query: "",
      }),
    });
    assert.equal(goodPublishAuth.status, 204);

    const livePlayback = await request(
      `/api/v1/live-streams/${liveCreated.body.id}/playback`,
    );
    assert.equal(livePlayback.status, 200, JSON.stringify(livePlayback.body));
    assert.match(livePlayback.body.hlsUrl, /\/master\.m3u8$/);

    const playbackAuth = await fetch(
      base + "/api/v1/live/playback-auth",
      {
        headers: {
          "X-Forwarded-Uri": new URL(livePlayback.body.hlsUrl).pathname,
        },
      },
    );
    assert.equal(playbackAuth.status, 204);

    const backupPublishAuth = await fetch(base + "/api/v1/live/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user: "",
        password: "",
        token: liveCreated.body.backupStreamKey,
        action: "publish",
        path: backupLivePath,
        protocol: "srt",
        id: "integration-backup-publisher",
        query: "",
      }),
    });
    assert.equal(backupPublishAuth.status, 204);

    await db.query(
      "UPDATE workspaces SET live_concurrency_limit=1 WHERE id=$1",
      [ws.id],
    );
    await db.query(
      "UPDATE live_streams SET status='live' WHERE id=$1",
      [liveCreated.body.id],
    );
    const secondLive = await request("/api/v1/live-streams", "POST", {
      workspaceId: ws.id,
      name: "Quota stream",
    });
    assert.equal(secondLive.status, 201);
    const concurrentDenied = await fetch(base + "/api/v1/live/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user: "",
        password: "",
        token: secondLive.body.streamKey,
        action: "publish",
        path: `live/${secondLive.body.id}/primary`,
        protocol: "rtmp",
        id: "quota-publisher",
        query: "",
      }),
    });
    assert.equal(concurrentDenied.status, 403);

    await db.query(
      `UPDATE workspaces
       SET live_concurrency_limit=3,live_minutes_monthly_limit=1
       WHERE id=$1`,
      [ws.id],
    );
    await db.query(
      `INSERT INTO usage_records(
         workspace_id,kind,amount,idempotency_key
       ) VALUES($1,'live_seconds',60,$2)`,
      [ws.id, `quota-live-${randomUUID()}`],
    );
    await db.query(
      "UPDATE live_streams SET status='ended' WHERE id=$1",
      [liveCreated.body.id],
    );
    const monthlyDenied = await fetch(base + "/api/v1/live/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user: "",
        password: "",
        token: secondLive.body.streamKey,
        action: "publish",
        path: `live/${secondLive.body.id}/primary`,
        protocol: "rtmp",
        id: "monthly-quota-publisher",
        query: "",
      }),
    });
    assert.equal(monthlyDenied.status, 403);

    const liveUsage = await request(`/api/v1/workspaces/${ws.id}/usage`);
    assert.equal(liveUsage.status, 200);
    assert.equal(Number(liveUsage.body.live_concurrency_limit), 3);
    assert.equal(Number(liveUsage.body.live_minutes_monthly_limit), 1);
    assert.ok(Number(liveUsage.body.live_seconds_this_month) >= 60);

    const rotated = await request(
      `/api/v1/live-streams/${liveCreated.body.id}/rotate-key`,
      "POST",
      {},
    );
    assert.equal(rotated.status, 200);
    assert.match(rotated.body.streamKey, /^sf_stream_/);

    const oldKeyAfterRotate = await fetch(base + "/api/v1/live/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user: "",
        password: "",
        token: liveCreated.body.streamKey,
        action: "publish",
        path: livePath,
        protocol: "rtmp",
        id: "integration-publisher-2",
        query: "",
      }),
    });
    assert.equal(oldKeyAfterRotate.status, 403);

    const liveToggle = await request(
      `/api/v1/live-streams/${liveCreated.body.id}`,
      "PATCH",
      { autoCreateVod: false },
    );
    assert.equal(liveToggle.status, 200);
    const liveListAfterToggle = await request(
      `/api/v1/live-streams?workspaceId=${ws.id}`,
    );
    const toggled = liveListAfterToggle.body.find(
      (stream: any) => stream.id === liveCreated.body.id,
    );
    assert.equal(toggled.auto_create_vod, false);

    const retrySessionId = randomUUID();
    await db.query(
      `INSERT INTO live_sessions(
         id,stream_id,started_at,ended_at,promotion_status,promotion_error
       ) VALUES($1,$2,now()-interval '1 minute',now(),'failed','test')`,
      [retrySessionId, liveCreated.body.id],
    );
    const retryPromotion = await request(
      `/api/v1/live-streams/${liveCreated.body.id}/sessions/${retrySessionId}/retry-promotion`,
      "POST",
      {},
    );
    assert.equal(
      retryPromotion.status,
      200,
      JSON.stringify(retryPromotion.body),
    );
    assert.equal(retryPromotion.body.status, "queued");
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
      const subtitleUpload = await request(
        `/api/v1/videos/${v.id}/subtitles`,
        "POST",
        {
          language: "ar",
          label: "العربية",
          content:
            "1\n00:00:00,000 --> 00:00:01,000\nمرحبا بالعالم\n\n2\n00:00:02,000 --> 00:00:03,500\nتجربة البحث",
        },
      );
      assert.equal(subtitleUpload.status, 200, JSON.stringify(subtitleUpload.body));
      assert.equal(subtitleUpload.body.transcriptSegments, 2);
      const renewedPlayback = await request(
        `/api/v1/videos/${v.id}/playback/refresh`,
        "POST",
        { token: playback.token },
      );
      assert.equal(
        renewedPlayback.status,
        200,
        JSON.stringify(renewedPlayback.body),
      );
      assert.equal(renewedPlayback.body.sessionId, playback.sessionId);
      assert.notEqual(renewedPlayback.body.token, playback.token);
      assert.equal(renewedPlayback.body.subtitles.length, 1);
      assert.equal(renewedPlayback.body.subtitles[0].language, "ar");
      assert.match(renewedPlayback.body.subtitles[0].url, /token=/);

      const embedPolicy = await request(
        `/api/v1/videos/${v.id}/embed-policy`,
        "PUT",
        { allowedOrigins: ["https://allowed.example/path"] },
      );
      assert.equal(embedPolicy.status, 200, JSON.stringify(embedPolicy.body));
      assert.deepEqual(embedPolicy.body.allowedOrigins, [
        "https://allowed.example",
      ]);
      const embedToken = new URL(playback.embedUrl).hash.replace(
        "#token=",
        "",
      );
      assert.equal(
        (
          await request(`/api/v1/videos/${v.id}/embed/playback`, "POST", {
            token: embedToken,
            parentOrigin: "https://blocked.example",
          })
        ).status,
        403,
      );
      const embedPlayback = await request(
        `/api/v1/videos/${v.id}/embed/playback`,
        "POST",
        {
          token: embedToken,
          parentOrigin: "https://allowed.example/some/page",
        },
      );
      assert.equal(
        embedPlayback.status,
        200,
        JSON.stringify(embedPlayback.body),
      );
      assert.equal(embedPlayback.body.subtitles.length, 1);
      assert.equal(
        (
          await request(
            `/api/v1/videos/${v.id}/playback/refresh`,
            "POST",
            {
              token: embedPlayback.body.token,
              parentOrigin: "https://blocked.example",
            },
          )
        ).status,
        403,
      );
      assert.equal(
        (
          await request(
            `/api/v1/videos/${v.id}/playback/refresh`,
            "POST",
            {
              token: embedPlayback.body.token,
              parentOrigin: "https://allowed.example",
            },
          )
        ).status,
        200,
      );
      const transcriptSearch = await request(
        `/api/v1/videos/${v.id}/transcript?search=${encodeURIComponent("البحث")}`,
      );
      assert.equal(transcriptSearch.status, 200);
      assert.equal(transcriptSearch.body.items.length, 1);
      assert.equal(transcriptSearch.body.items[0].text, "تجربة البحث");
      const workspaceTranscriptSearch = await request(
        `/api/v1/transcripts/search?workspaceId=${ws.id}&q=${encodeURIComponent("مرحبا")}`,
      );
      assert.equal(workspaceTranscriptSearch.status, 200);
      assert.equal(workspaceTranscriptSearch.body.length, 1);
      assert.equal(workspaceTranscriptSearch.body[0].video_id, v.id);
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

      assert.equal(
        (
          await request(`/api/v1/videos/${v.id}/ai-generations`, "POST", {
            kind: "all",
            language: "ar",
          })
        ).status,
        503,
      );
      const aiGenerationId = randomUUID();
      await db.query(
        `INSERT INTO ai_generations(
           id,video_id,kind,language,provider,model,status,result,completed_at
         ) VALUES($1,$2,'all','ar','test','test-model','complete',$3,now())`,
        [
          aiGenerationId,
          v.id,
          JSON.stringify({
            summary: "ملخص تجريبي",
            title: "عنوان مقترح",
            description: "وصف مقترح من النص.",
            tags: ["اختبار", "فيديو"],
            chapters: [
              { startSeconds: 0, title: "البداية" },
              { startSeconds: 3, title: "الجزء الثاني" },
            ],
          }),
        ],
      );
      const aiApply = await request(
        `/api/v1/videos/${v.id}/ai-generations/${aiGenerationId}/apply`,
        "POST",
        { metadata: true, chapters: true },
      );
      assert.equal(aiApply.status, 200, JSON.stringify(aiApply.body));
      const aiUpdatedVideo = await request(`/api/v1/videos/${v.id}`);
      assert.equal(aiUpdatedVideo.body.title, "عنوان مقترح");
      assert.deepEqual(aiUpdatedVideo.body.tags, ["اختبار", "فيديو"]);
      const aiUpdatedChapters = await request(
        `/api/v1/videos/${v.id}/chapters`,
      );
      assert.deepEqual(
        aiUpdatedChapters.body.map((chapter: any) => chapter.title),
        ["البداية", "الجزء الثاني"],
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
          await request(`/api/v1/playlists/${playlistId}`, "PATCH", {
            name: "Curated integration playlist",
          })
        ).status,
        200,
      );
      assert.equal(
        (
          await request(`/api/v1/playlists/${playlistId}/items`, "PUT", {
            videoIds: [v.id, replacementId],
          })
        ).status,
        200,
      );
      assert.deepEqual(
        (
          await request(`/api/v1/playlists/${playlistId}`)
        ).body.items.map((item: any) => item.id),
        [v.id, replacementId],
      );
      assert.equal(
        (
          await request(`/api/v1/playlists/${playlistId}/items`, "PUT", {
            videoIds: [replacementId, v.id],
          })
        ).status,
        200,
      );
      assert.deepEqual(
        (
          await request(`/api/v1/playlists/${playlistId}`)
        ).body.items.map((item: any) => item.id),
        [replacementId, v.id],
      );
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
        deviceType: "desktop",
        browserFamily: "chrome",
        osFamily: "linux",
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
      const breakdown = await request(
        `/api/v1/videos/${v.id}/analytics/breakdown?days=30`,
      );
      assert.equal(breakdown.status, 200);
      assert.equal(Number(breakdown.body.totalSessions), 1);
      assert.equal(Number(breakdown.body.devices.desktop), 1);
      assert.equal(Number(breakdown.body.browsers.chrome), 1);
      assert.equal(Number(breakdown.body.operatingSystems.linux), 1);
      let daily: any[] = [];
      for (let i = 0; i < 20; i++) {
        const result = await request(
          `/api/v1/videos/${v.id}/analytics/daily?days=1`,
        );
        daily = result.body;
        if (daily.length && Number(daily[0].plays) === 1) break;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      assert.equal(daily.length, 1);
      assert.equal(Number(daily[0].plays), 1);
      assert.equal(Number(daily[0].unique_viewers), 1);
      assert.equal(Number(daily[0].watch_seconds), 5);
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
      const metricsResponse = await fetch("http://api:9091/metrics");
      assert.equal(metricsResponse.status, 200);
      const metricsText = await metricsResponse.text();
      for (const metric of [
        "streamforge_queue_jobs",
        "streamforge_processing_jobs",
        "streamforge_live_streams",
        "streamforge_live_active_ingest",
        "streamforge_source_storage_bytes",
        "streamforge_output_storage_bytes",
        "streamforge_worker_heartbeats",
        "streamforge_metrics_refresh_success",
      ])
        assert.ok(
          metricsText.includes(metric),
          `missing operational metric: ${metric}`,
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
