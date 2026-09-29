import type { FastifyInstance } from "fastify";
import { SignJWT, jwtVerify } from "jose";
import { z } from "zod";
import { db, transaction } from "../../../packages/shared/src/db.js";
import { storage } from "../../../packages/shared/src/storage.js";
import { config } from "../../../packages/config/src/index.js";
import { videoAccess, ApiError, uuid, playbackSecret } from "./context.js";
import { subtitleVtt, subtitleSegments } from "../../../packages/media-core/src/index.js";
export async function playbackClaims(token: string) {
  try {
    return (
      await jwtVerify(token, playbackSecret, {
        issuer: "streamforge",
        audience: "playback",
      })
    ).payload;
  } catch {
    throw new ApiError(401, "INVALID_PLAYBACK_TOKEN");
  }
}

function coarseClient(userAgent = "") {
  const ua = userAgent.toLowerCase();
  const deviceType = /ipad|tablet/.test(ua)
    ? "tablet"
    : /mobile|iphone|android/.test(ua)
      ? "mobile"
      : "desktop";
  const browser = /edg\//.test(ua)
    ? "edge"
    : /firefox\//.test(ua)
      ? "firefox"
      : /chrome\//.test(ua)
        ? "chrome"
        : /safari\//.test(ua)
          ? "safari"
          : "other";
  const os = /android/.test(ua)
    ? "android"
    : /iphone|ipad|ios/.test(ua)
      ? "ios"
      : /windows/.test(ua)
        ? "windows"
        : /mac os|macintosh/.test(ua)
          ? "macos"
          : /linux/.test(ua)
            ? "linux"
            : "other";
  return { deviceType, browser, os };
}
export async function playbackRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string } }>(
    "/api/v1/videos/:id/playback",
    async (req) => {
      uuid.parse(req.params.id);
      const v = (
        await db.query(
          "SELECT * FROM videos WHERE id=$1 AND deleted_at IS NULL",
          [req.params.id],
        )
      ).rows[0];
      if (!v || v.status !== "ready")
        throw new ApiError(404, "VIDEO_NOT_READY");
      if (v.privacy !== "public") await videoAccess(req, v.id);
      const client = coarseClient(req.headers["user-agent"]);
      const session = (
        await db.query(
          `INSERT INTO playback_sessions(
             video_id,expires_at,last_seen_at,device_type,browser,os
           ) VALUES($1,now()+$2*interval '1 second',now(),$3,$4,$5)
           RETURNING id`,
          [
            v.id,
            config.PLAYBACK_TTL_SECONDS,
            client.deviceType,
            client.browser,
            client.os,
          ],
        )
      ).rows[0];
      const token = await new SignJWT({
        videoId: v.id,
        sessionId: session.id,
        prefix: v.output_prefix,
      })
        .setProtectedHeader({ alg: "HS256" })
        .setIssuer("streamforge")
        .setAudience("playback")
        .setIssuedAt()
        .setExpirationTime(`${config.PLAYBACK_TTL_SECONDS}s`)
        .sign(playbackSecret);
      const base = `${config.PUBLIC_URL}/api/v1/media/${v.id}/`;
      const suffix = `?token=${token}`;
      return {
        token,
        sessionId: session.id,
        expiresIn: config.PLAYBACK_TTL_SECONDS,
        url: base + "hls/master.m3u8" + suffix,
        poster: base + "thumbnails/poster.jpg" + suffix,
        previews: base + "thumbnails/previews.vtt" + suffix,
        subtitles: (
          await db.query("SELECT * FROM subtitles WHERE video_id=$1", [v.id])
        ).rows.map((s) => ({
          id: s.id,
          language: s.language,
          label: s.label,
          default: s.is_default,
          forced: s.forced,
          url: base + `subtitles/${s.id}.vtt` + suffix,
        })),
        embedUrl: `${config.PUBLIC_URL}/embed/${v.id}#token=${token}`,
      };
    },
  );
  app.get<{
    Params: { id: string; "*": string };
    Querystring: { token: string };
  }>("/api/v1/media/:id/*", async (req, reply) => {
    const claims = await playbackClaims(req.query.token);
    if (claims.videoId !== req.params.id)
      throw new ApiError(403, "PLAYBACK_SCOPE_MISMATCH");
    const v = (
      await db.query(
        "SELECT output_prefix FROM videos WHERE id=$1 AND status='ready' AND deleted_at IS NULL",
        [req.params.id],
      )
    ).rows[0];
    if (!v || claims.prefix !== v.output_prefix)
      throw new ApiError(404, "VIDEO_UNAVAILABLE");
    const path = req.params["*"];
    if (
      !/^(hls\/(master\.m3u8|\d+p\/(index\.m3u8|segment-\d+\.ts))|thumbnails\/(poster\.jpg|\d{4}\.jpg|previews\.vtt)|subtitles\/[a-f0-9-]{36}\.vtt)$/.test(
        path,
      )
    )
      throw new ApiError(400, "INVALID_MEDIA_PATH");
    let key = v.output_prefix + path;
    if (path.startsWith("subtitles/")) {
      const s = (
        await db.query(
          "SELECT object_key FROM subtitles WHERE id=$1 AND video_id=$2",
          [path.split("/")[1].replace(".vtt", ""), req.params.id],
        )
      ).rows[0];
      if (!s) throw new ApiError(404, "SUBTITLE_NOT_FOUND");
      key = s.object_key;
    }
    reply
      .header("Cache-Control", "private, no-store")
      .header("Referrer-Policy", "no-referrer");
    const stream = await storage.get(key);
    if (path.endsWith(".m3u8") || path.endsWith("previews.vtt")) {
      let text = "";
      for await (const chunk of stream) text += chunk.toString();
      const suffix = `?token=${encodeURIComponent(req.query.token)}`;
      text = text
        .split("\n")
        .map((line) =>
          line && !line.startsWith("#") && /\.(ts|m3u8|jpg)$/.test(line)
            ? line + suffix
            : line,
        )
        .join("\n");
      return reply
        .type(
          path.endsWith(".m3u8") ? "application/vnd.apple.mpegurl" : "text/vtt",
        )
        .send(text);
    }
    return reply
      .type(
        path.endsWith(".ts")
          ? "video/mp2t"
          : path.endsWith(".vtt")
            ? "text/vtt"
            : "image/jpeg",
      )
      .send(stream);
  });
  app.post<{ Params: { id: string } }>(
    "/api/v1/videos/:id/subtitles",
    async (req) => {
      const v = await videoAccess(req, req.params.id, "editor", "videos:write");
      const b = z
        .object({
          language: z.string().regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/),
          label: z.string().min(1).max(80),
          content: z.string().max(500000),
          default: z.boolean().default(false),
          forced: z.boolean().default(false),
        })
        .parse(req.body);
      const id = crypto.randomUUID();
      let converted: string;
      try {
        converted = subtitleVtt(b.content);
      } catch {
        throw new ApiError(422, "INVALID_SUBTITLE");
      }
      const key = `workspaces/${v.workspace_id}/videos/${v.id}/subtitles/${id}.vtt`;
      await storage.put(key, Buffer.from(converted), "text/vtt");
      const segments = subtitleSegments(converted);
      await transaction(async (client) => {
        await client.query(
          "INSERT INTO subtitles(id,video_id,language,label,object_key,is_default,forced) VALUES($1,$2,$3,$4,$5,$6,$7)",
          [id, v.id, b.language, b.label, key, b.default, b.forced],
        );
        await client.query(
          `INSERT INTO transcript_segments(
             video_id,subtitle_id,language,start_seconds,end_seconds,text
           )
           SELECT $1,$2,$3,start_seconds,end_seconds,text
           FROM unnest($4::float8[],$5::float8[],$6::text[])
             AS cue(start_seconds,end_seconds,text)`,
          [
            v.id,
            id,
            b.language,
            segments.map((segment) => segment.startSeconds),
            segments.map((segment) => segment.endSeconds),
            segments.map((segment) => segment.text),
          ],
        );
      });
      return { id, transcriptSegments: segments.length };
    },
  );
  app.post("/api/v1/analytics/events", async (req) => {
    const b = z
      .object({
        token: z.string().max(2048),
        id: uuid,
        event: z.enum([
          "video_loaded",
          "play",
          "pause",
          "seek",
          "buffer_start",
          "buffer_end",
          "quality_change",
          "subtitle_change",
          "ended",
          "error",
          "heartbeat",
          "startup",
        ]),
        position: z.number().min(0).max(86400).default(0),
        watchSeconds: z.number().min(0).max(15).default(0),
        quality: z.string().regex(/^(auto|[0-9]{3,4}p)$/).optional(),
        durationMs: z.number().int().min(0).max(300000).optional(),
      })
      .parse(req.body);
    const claims = await playbackClaims(b.token);
    await transaction(async (client) => {
      await client.query(
        `INSERT INTO analytics_events(
           id,session_id,video_id,event,position,watch_seconds,quality,duration_ms
         )
         SELECT $1,id,video_id,$2,$3,$4,$5,$6
         FROM playback_sessions
         WHERE id=$7 AND expires_at>now()
         ON CONFLICT DO NOTHING`,
        [
          b.id,
          b.event,
          b.position,
          b.event === "heartbeat" ? b.watchSeconds : 0,
          b.quality ?? null,
          b.durationMs ?? null,
          claims.sessionId,
        ],
      );
      if (["play", "heartbeat", "quality_change"].includes(b.event))
        await client.query(
          `UPDATE playback_sessions
           SET last_seen_at=now(),
               current_quality=COALESCE($1,current_quality)
           WHERE id=$2 AND expires_at>now()`,
          [b.quality ?? null, claims.sessionId],
        );
    });
    return { ok: true };
  });
  app.get<{ Params: { id: string } }>(
    "/api/v1/videos/:id/analytics",
    async (req) => {
      await videoAccess(req, req.params.id, "viewer", "analytics:read");
      return (
        await db.query(
          `WITH video AS (
             SELECT COALESCE((metadata->>'duration')::float,0) AS duration
             FROM videos WHERE id=$1
           ),
           per_session AS (
             SELECT session_id,
                    max(position) AS max_position,
                    bool_or(event='ended') AS ended,
                    bool_or(event='play') AS played
             FROM analytics_events
             WHERE video_id=$1
             GROUP BY session_id
           ),
           event_totals AS (
             SELECT
               count(*) FILTER(WHERE event='play') AS plays,
               count(DISTINCT session_id) FILTER(WHERE event='play') AS unique_viewers,
               coalesce(sum(watch_seconds),0) AS watch_seconds,
               count(*) FILTER(WHERE event='ended') AS completions,
               count(*) FILTER(WHERE event='error') AS errors,
               count(*) FILTER(WHERE event='buffer_start') AS buffer_events,
               coalesce(sum(duration_ms) FILTER(WHERE event='buffer_end'),0) AS buffering_ms,
               coalesce(avg(duration_ms) FILTER(WHERE event='startup'),0) AS average_startup_ms
             FROM analytics_events
             WHERE video_id=$1
           )
           SELECT
             e.*,
             CASE WHEN e.unique_viewers=0 THEN 0
               ELSE round((e.completions::numeric/e.unique_viewers)*100,2)
             END AS completion_rate,
             CASE WHEN v.duration<=0 THEN 0
               ELSE round(coalesce(avg(least(1,p.max_position/v.duration))*100,0)::numeric,2)
             END AS average_watch_percentage,
             CASE WHEN (e.watch_seconds + e.buffering_ms/1000.0)<=0 THEN 0
               ELSE round(
                 ((e.buffering_ms/1000.0)/(e.watch_seconds + e.buffering_ms/1000.0)*100)::numeric,
                 2
               )
             END AS buffering_ratio,
             CASE WHEN e.unique_viewers=0 THEN 0
               ELSE round((e.errors::numeric/e.unique_viewers)*100,2)
             END AS error_rate
           FROM event_totals e
           CROSS JOIN video v
           LEFT JOIN per_session p ON true
           GROUP BY e.plays,e.unique_viewers,e.watch_seconds,e.completions,e.errors,
                    e.buffer_events,e.buffering_ms,e.average_startup_ms,v.duration`,
          [req.params.id],
        )
      ).rows[0];
    },
  app.get<{ Params: { id: string } }>(
    "/api/v1/videos/:id/analytics/realtime",
    async (req) => {
      await videoAccess(req, req.params.id, "viewer", "analytics:read");
      const active = await db.query(
        `SELECT
           count(*) AS active_viewers,
           jsonb_object_agg(quality,count) FILTER(WHERE quality IS NOT NULL) AS qualities
         FROM (
           SELECT COALESCE(current_quality,'auto') AS quality,count(*) AS count
           FROM playback_sessions
           WHERE video_id=$1
             AND expires_at>now()
             AND last_seen_at>now()-interval '30 seconds'
           GROUP BY COALESCE(current_quality,'auto')
         ) q`,
        [req.params.id],
      );
      const devices = await db.query(
        `SELECT device_type,count(*) AS viewers
         FROM playback_sessions
         WHERE video_id=$1
           AND expires_at>now()
           AND last_seen_at>now()-interval '30 seconds'
         GROUP BY device_type
         ORDER BY viewers DESC`,
        [req.params.id],
      );
      return {
        activeViewers: Number(active.rows[0]?.active_viewers ?? 0),
        qualities: active.rows[0]?.qualities ?? {},
        devices: devices.rows,
      };
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/v1/videos/:id/analytics/daily",
    async (req) => {
      await videoAccess(req, req.params.id, "viewer", "analytics:read");
      return (
        await db.query(
          `SELECT
             created_at::date AS date,
             count(*) FILTER(WHERE event='play') AS plays,
             count(DISTINCT session_id) FILTER(WHERE event='play') AS unique_viewers,
             coalesce(sum(watch_seconds),0) AS watch_seconds,
             count(*) FILTER(WHERE event='ended') AS completions,
             count(*) FILTER(WHERE event='error') AS errors,
             coalesce(sum(duration_ms) FILTER(WHERE event='buffer_end'),0) AS buffering_ms
           FROM analytics_events
           WHERE video_id=$1
           GROUP BY created_at::date
           ORDER BY date DESC
           LIMIT 90`,
          [req.params.id],
        )
      ).rows;
    },
  );
  );
}
