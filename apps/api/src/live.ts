import type { FastifyInstance } from "fastify";
import { SignJWT, jwtVerify } from "jose";
import { z } from "zod";
import { db, transaction } from "../../../packages/shared/src/db.js";
import { event } from "../../../packages/shared/src/events.js";
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

function streamIdFromPath(path: string) {
  const match = /^live\/([a-f0-9-]{36})$/.exec(path);
  return match?.[1];
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
      const streamId = streamIdFromPath(body.path);
      if (!streamId) return reply.code(403).send();

      const stream = (
        await db.query(
          "SELECT * FROM live_streams WHERE id=$1 AND path=$2 AND status<>'disabled'",
          [streamId, body.path],
        )
      ).rows[0];
      if (!stream) return reply.code(403).send();

      if (body.action === "publish") {
        const credential =
          body.token || queryToken(body.query) || body.password;
        if (!credential || hash(credential) !== stream.stream_key_hash)
          return reply.code(403).send();

        await transaction(async (client) => {
          const locked = (
            await client.query(
              "SELECT status,workspace_id FROM live_streams WHERE id=$1 FOR UPDATE",
              [stream.id],
            )
          ).rows[0];
          if (locked.status !== "live") {
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
            );
          }
        });
        return reply.code(204).send();
      }

      if (body.action === "read" || body.action === "playback") {
        const token =
          body.token || queryToken(body.query) || body.password;
        if (!token) return reply.code(401).send();
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

  app.post("/api/v1/live-streams", async (req, reply) => {
    const body = z
      .object({
        workspaceId: uuid,
        name: z.string().trim().min(1).max(200),
      })
      .parse(req.body);
    const a = await access(req, body.workspaceId, "editor", "videos:write");
    const id = crypto.randomUUID();
    const key = `sf_stream_${opaque()}`;
    const path = `live/${id}`;
    const row = (
      await db.query(
        `INSERT INTO live_streams(
           id,workspace_id,name,path,stream_key_hash,recording_enabled,created_by
         ) VALUES($1,$2,$3,$4,$5,$6,$7)
         RETURNING id,workspace_id,name,path,recording_enabled,status,created_at`,
        [
          id,
          body.workspaceId,
          body.name,
          path,
          hash(key),
          true,
          a.userId ?? null,
        ],
      )
    ).rows[0];
    await audit(body.workspaceId, a, "live-stream.created", id);
    return reply.code(201).send({
      ...row,
      streamKey: key,
      ingest: {
        rtmpServer: config.LIVE_PUBLIC_RTMP_URL,
        rtmpStreamKey: `${id}?token=${key}`,
        srtUrl:
          `${config.LIVE_PUBLIC_SRT_URL}?streamid=` +
          encodeURIComponent(`publish:${path}:streamforge:${key}`) +
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
           id,workspace_id,name,path,recording_enabled,status,
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
          `SELECT id,protocol,publisher_id,started_at,ended_at,bytes_received
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
        status: stream.status,
        last_started_at: stream.last_started_at,
        last_ended_at: stream.last_ended_at,
        created_at: stream.created_at,
        sessions,
      };
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
      await db.query(
        "UPDATE live_streams SET stream_key_hash=$1,updated_at=now() WHERE id=$2",
        [hash(key), stream.id],
      );
      await audit(stream.workspace_id, a, "live-stream.key-rotated", stream.id);
      return {
        streamKey: key,
        rtmpStreamKey: `${stream.id}?token=${key}`,
        srtUrl:
          `${config.LIVE_PUBLIC_SRT_URL}?streamid=` +
          encodeURIComponent(
            `publish:${stream.path}:streamforge:${key}`,
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
          `${config.LIVE_PUBLIC_HLS_URL}/${stream.id}/index.m3u8?token=${encodeURIComponent(token)}`,
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
