import type { FastifyInstance } from "fastify";
import { SignJWT, jwtVerify } from "jose";
import { z } from "zod";
import { db, transaction } from "../../../packages/shared/src/db.js";
import { enqueue } from "../../../packages/shared/src/events.js";
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
      const session = (
        await db.query(
          `INSERT INTO playback_sessions(video_id,expires_at) VALUES($1,now()+$2*interval '1 second') RETURNING id`,
          [v.id, config.PLAYBACK_TTL_SECONDS],
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
        ]),
        position: z.number().min(0).max(86400).default(0),
        watchSeconds: z.number().min(0).max(15).default(0),
        quality: z.string().regex(/^\d{3,4}p$/).optional(),
        startupMs: z.number().int().min(0).max(120000).optional(),
        deviceType: z.enum(["desktop","mobile","tablet","tv","other"]).optional(),
        browserFamily: z.enum(["chrome","firefox","safari","edge","other"]).optional(),
        osFamily: z.enum(["windows","macos","linux","android","ios","other"]).optional(),
      })
      .parse(req.body);
    const claims = await playbackClaims(b.token);
    await transaction(async (client) => {
      const inserted = await client.query(
        `INSERT INTO analytics_events(id,session_id,video_id,event,position,watch_seconds,quality,startup_ms)
         SELECT $1,id,video_id,$2,$3,$4,$5,$6
         FROM playback_sessions
         WHERE id=$7 AND expires_at>now()
         ON CONFLICT DO NOTHING
         RETURNING session_id,video_id,created_at`,
        [
          b.id,
          b.event,
          b.position,
          b.event === "heartbeat" ? b.watchSeconds : 0,
          b.quality ?? null,
          b.startupMs ?? null,
          claims.sessionId,
        ],
      );
      if (!inserted.rowCount) return;
      await client.query(
        `UPDATE playback_sessions
         SET last_seen_at=now(),
             device_type=coalesce(device_type,$2),
             browser_family=coalesce(browser_family,$3),
             os_family=coalesce(os_family,$4)
         WHERE id=$1`,
        [
          claims.sessionId,
          b.deviceType ?? null,
          b.browserFamily ?? null,
          b.osFamily ?? null,
        ],
      );
      const event = inserted.rows[0];
      await enqueue(client, "analytics", {
        videoId: event.video_id,
        day: new Date(event.created_at).toISOString().slice(0, 10),
      });
    });
    return { ok: true };
  });
  app.get<{ Params: { id: string } }>(
    "/api/v1/videos/:id/analytics",
    async (req) => {
      await videoAccess(req, req.params.id, "viewer", "analytics:read");
      return (
        await db.query(
          `WITH base AS (
             SELECT
               count(*) FILTER(WHERE event='play') AS plays,
               count(DISTINCT session_id) AS unique_viewers,
               coalesce(sum(watch_seconds),0) AS watch_seconds,
               count(*) FILTER(WHERE event='ended') AS completions,
               count(*) FILTER(WHERE event='error') AS errors,
               count(*) FILTER(WHERE event='buffer_start') AS buffer_starts,
               avg(startup_ms) FILTER(WHERE startup_ms IS NOT NULL) AS avg_startup_ms
             FROM analytics_events
             WHERE video_id=$1
           )
           SELECT
             base.*,
             CASE WHEN unique_viewers=0 THEN 0
                  ELSE completions::double precision / unique_viewers END AS completion_rate,
             CASE
               WHEN unique_viewers=0 OR coalesce((v.metadata->>'duration')::double precision,0)=0 THEN 0
               ELSE least(
                 100,
                 100 * watch_seconds::double precision /
                 (unique_viewers * (v.metadata->>'duration')::double precision)
               )
             END AS average_watch_percentage
           FROM base
           JOIN videos v ON v.id=$1`,
          [req.params.id],
        )
      ).rows[0];
    },
  );
  app.get<{
    Params: { id: string };
    Querystring: { days?: string };
  }>("/api/v1/videos/:id/analytics/daily", async (req) => {
    await videoAccess(req, req.params.id, "viewer", "analytics:read");
    const query = z
      .object({ days: z.coerce.number().int().min(1).max(90).default(30) })
      .parse(req.query);
    return (
      await db.query(
        `SELECT
           day,plays,unique_viewers,watch_seconds,completions,errors,
           buffer_starts,buffer_seconds,avg_startup_ms,
           CASE WHEN watch_seconds + buffer_seconds = 0 THEN 0
                ELSE buffer_seconds / (watch_seconds + buffer_seconds) END AS buffering_ratio
         FROM analytics_daily
         WHERE video_id=$1 AND day >= current_date - ($2::int - 1)
         ORDER BY day ASC`,
        [req.params.id, query.days],
      )
    ).rows;
  });
  app.get<{
    Params: { id: string };
    Querystring: { days?: string };
  }>("/api/v1/videos/:id/analytics/breakdown", async (req) => {
    await videoAccess(req, req.params.id, "viewer", "analytics:read");
    const query = z
      .object({ days: z.coerce.number().int().min(1).max(90).default(30) })
      .parse(req.query);
    const rows = (
      await db.query(
        `SELECT device_type,browser_family,os_family
         FROM playback_sessions
         WHERE video_id=$1
           AND last_seen_at >= now() - ($2::int * interval '1 day')`,
        [req.params.id, query.days],
      )
    ).rows;
    const count = (key: "device_type" | "browser_family" | "os_family") => {
      const out: Record<string, number> = {};
      for (const row of rows) {
        const value = row[key] ?? "other";
        out[value] = (out[value] ?? 0) + 1;
      }
      return out;
    };
    return {
      totalSessions: rows.length,
      devices: count("device_type"),
      browsers: count("browser_family"),
      operatingSystems: count("os_family"),
    };
  });
  app.get<{ Params: { id: string } }>(
    "/api/v1/videos/:id/analytics/realtime",
    async (req) => {
      await videoAccess(req, req.params.id, "viewer", "analytics:read");
      return (
        await db.query(
          `WITH recent AS (
             SELECT id
             FROM playback_sessions
             WHERE video_id=$1 AND last_seen_at > now() - interval '30 seconds'
           ),
           latest_quality AS (
             SELECT DISTINCT ON (e.session_id) e.session_id,e.quality
             FROM analytics_events e
             JOIN recent r ON r.id=e.session_id
             WHERE e.quality IS NOT NULL
             ORDER BY e.session_id,e.created_at DESC
           )
           SELECT
             (SELECT count(*) FROM recent) AS active_viewers,
             coalesce(
               jsonb_object_agg(quality,viewer_count) FILTER(WHERE quality IS NOT NULL),
               '{}'::jsonb
             ) AS qualities
           FROM (
             SELECT quality,count(*) AS viewer_count
             FROM latest_quality
             GROUP BY quality
           ) q`,
          [req.params.id],
        )
      ).rows[0];
    },
  );
}
