import type { FastifyInstance } from "fastify";
import { SignJWT, jwtVerify } from "jose";
import { z } from "zod";
import { db, transaction } from "../../../packages/shared/src/db.js";
import { enqueue, event } from "../../../packages/shared/src/events.js";
import { hash, opaque } from "../../../packages/shared/src/security.js";
import { config } from "../../../packages/config/src/index.js";
import {
  access,
  audit,
  ApiError,
  playbackSecret,
  uuid,
} from "./context.js";

const authBody = z.object({
  user: z.string().default(""),
  password: z.string().default(""),
  token: z.string().default(""),
  action: z.enum(["publish", "read", "playback", "api", "metrics", "pprof"]),
  path: z.string().max(500),
  protocol: z.string().max(30).default(""),
  id: z.string().max(200).default(""),
  query: z.string().max(4000).default(""),
}).passthrough();

function queryToken(query: string) {
  try {
    return new URLSearchParams(query.replace(/^\?/, "")).get("token") ?? "";
  } catch {
    return "";
  }
}

function streamPath(path: string) {
  const match = /^live\/([a-f0-9-]{36})(?:\/(primary|backup))?$/.exec(path);
  if (!match) return null;
  return {
    streamId: match[1]!,
    ingest: (match[2] ?? "primary") as "primary" | "backup",
  };
}

async function liveClaims(token: string) {
  try {
    return (
      await jwtVerify(token, playbackSecret, {
        issuer: "streamforge",
        audience: "live-playback",
      })
    ).payload;
  } catch {
    throw new ApiError(401, "INVALID_LIVE_TOKEN");
  }
}

export async function liveRoutes(app: FastifyInstance) {
  app.post(
    "/api/v1/live/auth",
    { config: { rateLimit: false } },
    async (req, reply) => {
      const body = authBody.parse(req.body);
      const parsedPath = streamPath(body.path);
      if (!parsedPath) return reply.code(403).send();

      const stream = (
        await db.query(
          "SELECT * FROM live_streams WHERE id=$1 AND status<>'disabled'",
          [parsedPath.streamId],
        )
      ).rows[0];
      if (!stream) return reply.code(403).send();

      if (body.action === "publish") {
        const credential =
          body.token || queryToken(body.query) || body.password;
        const expectedHash =
          parsedPath.ingest === "backup"
            ? stream.backup_stream_key_hash
            : stream.stream_key_hash;
        if (!credential || !expectedHash || hash(credential) !== expectedHash)
          return reply.code(403).send();

        await transaction(async (client) => {
          const locked = (
            await client.query(
              "SELECT status,workspace_id FROM live_streams WHERE id=$1 FOR UPDATE",
              [stream.id],
            )
          ).rows[0];
          if (locked.status !== "live") {
            const quota = (
              await client.query(
                `SELECT
                   live_concurrency_limit,
                   live_minutes_monthly_limit
                 FROM workspaces
                 WHERE id=$1
                 FOR UPDATE`,
                [locked.workspace_id],
              )
            ).rows[0];
            if (!quota) throw new ApiError(404, "WORKSPACE_NOT_FOUND");

            const activeStreams = Number(
              (
                await client.query(
                  `SELECT count(*)::int AS count
                   FROM live_streams
                   WHERE workspace_id=$1
                     AND status='live'
                     AND id<>$2`,
                  [locked.workspace_id, stream.id],
                )
              ).rows[0].count,
            );
            if (activeStreams >= Number(quota.live_concurrency_limit))
              throw new ApiError(403, "LIVE_CONCURRENCY_QUOTA_EXCEEDED");

            const liveUsage = (
              await client.query(
                `SELECT
                   coalesce(
                     (SELECT sum(amount)
                      FROM usage_records
                      WHERE workspace_id=$1
                        AND kind='live_seconds'
                        AND created_at>=date_trunc('month',now())),
                     0
                   )::bigint
                   +
                   coalesce(
                     (SELECT sum(
                        greatest(
                          0,
                          extract(epoch FROM (now()-lses.started_at))
                        )
                      )
                      FROM live_sessions lses
                      JOIN live_streams lstr ON lstr.id=lses.stream_id
                      WHERE lstr.workspace_id=$1
                        AND lses.ended_at IS NULL),
                     0
                   )::bigint AS seconds`,
                [locked.workspace_id],
              )
            ).rows[0];
            if (
              Number(quota.live_minutes_monthly_limit) > 0 &&
              Number(liveUsage.seconds) >=
                Number(quota.live_minutes_monthly_limit) * 60
            )
              throw new ApiError(403, "LIVE_MONTHLY_QUOTA_EXCEEDED");

            await client.query(
              `UPDATE live_streams
               SET status='live',last_started_at=now(),updated_at=now()
               WHERE id=$1`,
              [stream.id],
            );
            await client.query(
              `INSERT INTO live_sessions(stream_id,protocol,publisher_id)
               VALUES($1,$2,$3)`,
              [
                stream.id,
                ["rtmp", "srt", "rtsp", "webrtc"].includes(body.protocol)
                  ? body.protocol
                  : null,
                body.id || null,
              ],
            );
            await event(
              client,
              locked.workspace_id,
              stream.id,
              "live.started",
              "streamId",
            );
          }
        });
        return reply.code(204).send();
      }

      if (body.action === "read" || body.action === "playback") {
        const token =
          body.token || queryToken(body.query) || body.password;
        if (!token) return reply.code(401).send();
        if (body.action === "read" && token === config.LIVE_TRANSCODER_TOKEN)
          return reply.code(204).send();
        try {
          const claims = await liveClaims(token);
          if (
            claims.kind !== "live" ||
            claims.streamId !== stream.id ||
            claims.path !== stream.path
          )
            return reply.code(403).send();
          return reply.code(204).send();
        } catch {
          return reply.code(403).send();
        }
      }

      return reply.code(403).send();
    },
  );

  app.get("/api/v1/live/playback-auth", async (req, reply) => {
    const forwarded = String(req.headers["x-forwarded-uri"] ?? "");
    const match = /^\/live\/([a-f0-9-]{36})\/([^/]+)\/.+/.exec(forwarded);
    if (!match) return reply.code(403).send();
    const token = match[2]!;

    try {
      const claims = await liveClaims(token);
      if (claims.kind !== "live" || claims.streamId !== match[1])
        return reply.code(403).send();
      const stream = await db.query(
        "SELECT 1 FROM live_streams WHERE id=$1 AND status<>'disabled'",
        [match[1]],
      );
      if (!stream.rowCount) return reply.code(403).send();
      return reply.code(204).send();
    } catch {
      return reply.code(403).send();
    }
  });

  app.post("/api/v1/live-streams", async (req, reply) => {
    const body = z
      .object({
        workspaceId: uuid,
        name: z.string().trim().min(1).max(200),
        autoCreateVod: z.boolean().default(true),
        dvrWindowSeconds: z.number().int().min(30).max(21600).default(600),
        liveProfile: z.enum(["source", "standard", "high"]).default("standard"),
      })
      .parse(req.body);
    const a = await access(req, body.workspaceId, "editor", "videos:write");
    const id = crypto.randomUUID();
    const key = `sf_stream_${opaque()}`;
    const backupKey = `sf_stream_${opaque()}`;
    const path = `live/${id}`;
    const row = (
      await db.query(
        `INSERT INTO live_streams(
           id,workspace_id,name,path,stream_key_hash,backup_stream_key_hash,
           recording_enabled,auto_create_vod,dvr_window_seconds,live_profile,created_by
         ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         RETURNING id,workspace_id,name,path,recording_enabled,auto_create_vod,
                   dvr_window_seconds,live_profile,status,created_at`,
        [
          id,
          body.workspaceId,
          body.name,
          path,
          hash(key),
          hash(backupKey),
          true,
          body.autoCreateVod,
          body.dvrWindowSeconds,
          body.liveProfile,
          a.userId ?? null,
        ],
      )
    ).rows[0];
    await audit(body.workspaceId, a, "live-stream.created", id);
    return reply.code(201).send({
      ...row,
      streamKey: key,
      backupStreamKey: backupKey,
      ingest: {
        rtmpServer: config.LIVE_PUBLIC_RTMP_URL,
        primaryRtmpStreamKey: `${id}/primary?token=${key}`,
        backupRtmpStreamKey: `${id}/backup?token=${backupKey}`,
        primarySrtUrl:
          `${config.LIVE_PUBLIC_SRT_URL}?streamid=` +
          encodeURIComponent(`publish:${path}/primary:streamforge:${key}`) +
          "&pkt_size=1316",
        backupSrtUrl:
          `${config.LIVE_PUBLIC_SRT_URL}?streamid=` +
          encodeURIComponent(
            `publish:${path}/backup:streamforge:${backupKey}`,
          ) +
          "&pkt_size=1316",
      },
    });
  });

  app.get("/api/v1/live-streams", async (req) => {
    const query = z.object({ workspaceId: uuid }).parse(req.query);
    await access(req, query.workspaceId);
    return (
      await db.query(
        `SELECT
           id,workspace_id,name,path,recording_enabled,auto_create_vod,status,
           active_ingest,dvr_window_seconds,live_profile,
           last_started_at,last_ended_at,created_at,updated_at
         FROM live_streams
         WHERE workspace_id=$1
         ORDER BY created_at DESC`,
        [query.workspaceId],
      )
    ).rows;
  });

  app.get<{ Params: { id: string } }>(
    "/api/v1/live-streams/:id",
    async (req) => {
      uuid.parse(req.params.id);
      const stream = (
        await db.query(
          "SELECT * FROM live_streams WHERE id=$1",
          [req.params.id],
        )
      ).rows[0];
      if (!stream) throw new ApiError(404, "LIVE_STREAM_NOT_FOUND");
      await access(req, stream.workspace_id);
      const sessions = (
        await db.query(
          `SELECT
             id,protocol,publisher_id,started_at,ended_at,bytes_received,
             promotion_status,recording_video_id,promotion_error,promoted_at
           FROM live_sessions
           WHERE stream_id=$1
           ORDER BY started_at DESC
           LIMIT 20`,
          [stream.id],
        )
      ).rows;
      return {
        id: stream.id,
        workspace_id: stream.workspace_id,
        name: stream.name,
        path: stream.path,
        recording_enabled: stream.recording_enabled,
        auto_create_vod: stream.auto_create_vod,
        status: stream.status,
        active_ingest: stream.active_ingest,
        dvr_window_seconds: stream.dvr_window_seconds,
        live_profile: stream.live_profile,
        last_started_at: stream.last_started_at,
        last_ended_at: stream.last_ended_at,
        created_at: stream.created_at,
        sessions,
      };
    },
  );

  app.patch<{ Params: { id: string } }>(
    "/api/v1/live-streams/:id",
    async (req) => {
      uuid.parse(req.params.id);
      const stream = (
        await db.query("SELECT * FROM live_streams WHERE id=$1", [req.params.id])
      ).rows[0];
      if (!stream) throw new ApiError(404, "LIVE_STREAM_NOT_FOUND");
      const a = await access(
        req,
        stream.workspace_id,
        "editor",
        "videos:write",
      );
      const body = z
        .object({
          name: z.string().trim().min(1).max(200).optional(),
          autoCreateVod: z.boolean().optional(),
          dvrWindowSeconds: z.number().int().min(30).max(21600).optional(),
          liveProfile: z.enum(["source", "standard", "high"]).optional(),
        })
        .refine(
          (value) =>
            value.name !== undefined ||
            value.autoCreateVod !== undefined ||
            value.dvrWindowSeconds !== undefined ||
            value.liveProfile !== undefined,
          "NO_CHANGES",
        )
        .parse(req.body ?? {});
      await db.query(
        `UPDATE live_streams
         SET name=coalesce($1,name),
             auto_create_vod=coalesce($2,auto_create_vod),
             dvr_window_seconds=coalesce($3,dvr_window_seconds),
             live_profile=coalesce($4,live_profile),
             updated_at=now()
         WHERE id=$5`,
        [
          body.name ?? null,
          body.autoCreateVod ?? null,
          body.dvrWindowSeconds ?? null,
          body.liveProfile ?? null,
          stream.id,
        ],
      );
      await audit(stream.workspace_id, a, "live-stream.updated", stream.id);
      return { ok: true };
    },
  );

  app.post<{ Params: { id: string; sessionId: string } }>(
    "/api/v1/live-streams/:id/sessions/:sessionId/retry-promotion",
    async (req) => {
      uuid.parse(req.params.id);
      uuid.parse(req.params.sessionId);
      const stream = (
        await db.query("SELECT * FROM live_streams WHERE id=$1", [req.params.id])
      ).rows[0];
      if (!stream) throw new ApiError(404, "LIVE_STREAM_NOT_FOUND");
      await access(req, stream.workspace_id, "editor", "videos:write");
      return transaction(async (client) => {
        const session = (
          await client.query(
            `SELECT *
             FROM live_sessions
             WHERE id=$1 AND stream_id=$2
             FOR UPDATE`,
            [req.params.sessionId, stream.id],
          )
        ).rows[0];
        if (!session) throw new ApiError(404, "LIVE_SESSION_NOT_FOUND");
        if (!session.ended_at)
          throw new ApiError(409, "LIVE_SESSION_NOT_ENDED");
        if (session.promotion_status === "complete")
          return {
            ok: true,
            videoId: session.recording_video_id,
            status: "complete",
          };
        await client.query(
          `UPDATE live_sessions
           SET promotion_status='queued',promotion_error=NULL
           WHERE id=$1`,
          [session.id],
        );
        await enqueue(client, "live-import", {
          sessionId: session.id,
          force: true,
        });
        return { ok: true, status: "queued" };
      });
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/v1/live-streams/:id/rotate-key",
    async (req) => {
      uuid.parse(req.params.id);
      const stream = (
        await db.query("SELECT * FROM live_streams WHERE id=$1", [req.params.id])
      ).rows[0];
      if (!stream) throw new ApiError(404, "LIVE_STREAM_NOT_FOUND");
      const a = await access(
        req,
        stream.workspace_id,
        "editor",
        "videos:write",
      );
      const key = `sf_stream_${opaque()}`;
      const backupKey = `sf_stream_${opaque()}`;
      await db.query(
        `UPDATE live_streams
         SET stream_key_hash=$1,backup_stream_key_hash=$2,updated_at=now()
         WHERE id=$3`,
        [hash(key), hash(backupKey), stream.id],
      );
      await audit(stream.workspace_id, a, "live-stream.key-rotated", stream.id);
      return {
        streamKey: key,
        backupStreamKey: backupKey,
        primaryRtmpStreamKey: `${stream.id}/primary?token=${key}`,
        backupRtmpStreamKey: `${stream.id}/backup?token=${backupKey}`,
        primarySrtUrl:
          `${config.LIVE_PUBLIC_SRT_URL}?streamid=` +
          encodeURIComponent(
            `publish:${stream.path}/primary:streamforge:${key}`,
          ) +
          "&pkt_size=1316",
        backupSrtUrl:
          `${config.LIVE_PUBLIC_SRT_URL}?streamid=` +
          encodeURIComponent(
            `publish:${stream.path}/backup:streamforge:${backupKey}`,
          ) +
          "&pkt_size=1316",
      };
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/v1/live-streams/:id/playback",
    async (req) => {
      uuid.parse(req.params.id);
      const stream = (
        await db.query("SELECT * FROM live_streams WHERE id=$1", [req.params.id])
      ).rows[0];
      if (!stream || stream.status === "disabled")
        throw new ApiError(404, "LIVE_STREAM_NOT_FOUND");
      await access(req, stream.workspace_id);
      const token = await new SignJWT({
        kind: "live",
        streamId: stream.id,
        path: stream.path,
      })
        .setProtectedHeader({ alg: "HS256" })
        .setIssuer("streamforge")
        .setAudience("live-playback")
        .setIssuedAt()
        .setExpirationTime("15m")
        .sign(playbackSecret);
      return {
        token,
        expiresIn: 900,
        hlsUrl:
          `${config.LIVE_PUBLIC_HLS_URL}/${stream.id}/${encodeURIComponent(token)}/master.m3u8`,
      };
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/api/v1/live-streams/:id",
    async (req) => {
      uuid.parse(req.params.id);
      const stream = (
        await db.query("SELECT * FROM live_streams WHERE id=$1", [req.params.id])
      ).rows[0];
      if (!stream) throw new ApiError(404, "LIVE_STREAM_NOT_FOUND");
      const a = await access(
        req,
        stream.workspace_id,
        "editor",
        "videos:write",
      );
      await db.query(
        `UPDATE live_streams
         SET status='disabled',updated_at=now()
         WHERE id=$1`,
        [stream.id],
      );
      await audit(stream.workspace_id, a, "live-stream.disabled", stream.id);
      return { ok: true };
    },
  );
}
