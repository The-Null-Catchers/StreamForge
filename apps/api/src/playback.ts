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
        for (const segment of segments)
          await client.query(
            "INSERT INTO transcript_segments(video_id,subtitle_id,language,start_seconds,end_seconds,text) VALUES($1,$2,$3,$4,$5,$6)",
            [
              v.id,
              id,
              b.language,
              segment.startSeconds,
              segment.endSeconds,
              segment.text,
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
      })
      .parse(req.body);
    const claims = await playbackClaims(b.token);
    await db.query(
      "INSERT INTO analytics_events(id,session_id,video_id,event,position,watch_seconds) SELECT $1,id,video_id,$2,$3,$4 FROM playback_sessions WHERE id=$5 AND expires_at>now() ON CONFLICT DO NOTHING",
      [
        b.id,
        b.event,
        b.position,
        b.event === "heartbeat" ? b.watchSeconds : 0,
        claims.sessionId,
      ],
    );
    return { ok: true };
  });
  app.get<{ Params: { id: string } }>(
    "/api/v1/videos/:id/analytics",
    async (req) => {
      await videoAccess(req, req.params.id, "viewer", "analytics:read");
      return (
        await db.query(
          `SELECT count(*) FILTER(WHERE event='play') AS plays,count(DISTINCT session_id) AS playback_sessions,coalesce(sum(watch_seconds),0) AS watch_seconds,count(*) FILTER(WHERE event='ended') AS completions,count(*) FILTER(WHERE event='error') AS errors FROM analytics_events WHERE video_id=$1`,
          [req.params.id],
        )
      ).rows[0];
    },
  );
}
