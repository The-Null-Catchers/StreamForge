import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db, transaction } from "../../../packages/shared/src/db.js";
import { enqueue, event } from "../../../packages/shared/src/events.js";
import {
  transcodingProfileInfo,
  transcodingProfiles,
} from "../../../packages/media-core/src/profiles.js";
import {
  access,
  videoAccess,
  audit,
  uuid,
  ApiError,
  actor,
} from "./context.js";

const transcodingProfileSchema = z.enum(transcodingProfiles);

export async function videoRoutes(app: FastifyInstance) {
  app.get("/api/v1/transcoding-profiles", async (req) => {
    await actor(req);
    return transcodingProfiles.map((id) => ({
      id,
      ...transcodingProfileInfo[id],
    }));
  });

  app.post("/api/v1/videos", async (req, reply) => {
    const b = z
      .object({
        workspaceId: uuid,
        title: z.string().trim().min(1).max(200),
        privacy: z.enum(["private", "unlisted", "public"]).default("private"),
        transcodingProfile: transcodingProfileSchema.default("balanced"),
      })
      .parse(req.body);
    await access(req, b.workspaceId, "editor", "videos:write");
    return reply.code(201).send(
      await transaction(async (c) => {
        const w = (
          await c.query(
            "SELECT video_limit FROM workspaces WHERE id=$1 FOR UPDATE",
            [b.workspaceId],
          )
        ).rows[0];
        const n = (
          await c.query(
            "SELECT count(*) FROM videos WHERE workspace_id=$1 AND deleted_at IS NULL",
            [b.workspaceId],
          )
        ).rows[0];
        if (Number(n.count) >= w.video_limit)
          throw new ApiError(409, "VIDEO_QUOTA_EXCEEDED");
        return (
          await c.query(
            "INSERT INTO videos(workspace_id,title,privacy,transcoding_profile) VALUES($1,$2,$3,$4) RETURNING *",
            [b.workspaceId, b.title, b.privacy, b.transcodingProfile],
          )
        ).rows[0];
      }),
    );
  });

  app.get("/api/v1/videos", async (req) => {
    const q = z
      .object({
        workspaceId: uuid,
        search: z.string().max(200).default(""),
        status: z.string().max(30).optional(),
        privacy: z.enum(["private", "unlisted", "public"]).optional(),
        createdAfter: z.iso.datetime({ offset: true }).optional(),
        createdBefore: z.iso.datetime({ offset: true }).optional(),
        minDuration: z.coerce.number().min(0).max(86400).optional(),
        maxDuration: z.coerce.number().min(0).max(86400).optional(),
        minHeight: z.coerce.number().int().min(1).max(8192).optional(),
        maxHeight: z.coerce.number().int().min(1).max(8192).optional(),
        limit: z.coerce.number().int().min(1).max(100).default(30),
        offset: z.coerce.number().int().min(0).max(100000).default(0),
        sort: z
          .enum(["latest", "oldest", "duration", "size"])
          .default("latest"),
      })
      .superRefine((value, ctx) => {
        if (
          value.minDuration !== undefined &&
          value.maxDuration !== undefined &&
          value.minDuration > value.maxDuration
        )
          ctx.addIssue({
            code: "custom",
            path: ["minDuration"],
            message: "minDuration must not exceed maxDuration",
          });
        if (
          value.minHeight !== undefined &&
          value.maxHeight !== undefined &&
          value.minHeight > value.maxHeight
        )
          ctx.addIssue({
            code: "custom",
            path: ["minHeight"],
            message: "minHeight must not exceed maxHeight",
          });
        if (
          value.createdAfter &&
          value.createdBefore &&
          new Date(value.createdAfter) > new Date(value.createdBefore)
        )
          ctx.addIssue({
            code: "custom",
            path: ["createdAfter"],
            message: "createdAfter must not exceed createdBefore",
          });
      })
      .parse(req.query);
    await access(req, q.workspaceId);
    const order = {
      latest: "created_at DESC,id DESC",
      oldest: "created_at ASC,id ASC",
      duration: "(metadata->>'duration')::float DESC NULLS LAST,id",
      size: "size DESC,id",
    }[q.sort];
    return {
      items: (
        await db.query(
          `SELECT *
           FROM videos
           WHERE workspace_id=$1
             AND deleted_at IS NULL
             AND (title ILIKE $2 OR filename ILIKE $2 OR description ILIKE $2 OR array_to_string(tags, ' ') ILIKE $2)
             AND ($3::text IS NULL OR status=$3)
             AND ($4::text IS NULL OR privacy=$4)
             AND ($5::timestamptz IS NULL OR created_at >= $5)
             AND ($6::timestamptz IS NULL OR created_at <= $6)
             AND ($7::float8 IS NULL OR (metadata->>'duration')::float >= $7)
             AND ($8::float8 IS NULL OR (metadata->>'duration')::float <= $8)
             AND ($9::int IS NULL OR (metadata->>'height')::int >= $9)
             AND ($10::int IS NULL OR (metadata->>'height')::int <= $10)
           ORDER BY ${order}
           LIMIT $11 OFFSET $12`,
          [
            q.workspaceId,
            `%${q.search}%`,
            q.status,
            q.privacy,
            q.createdAfter ?? null,
            q.createdBefore ?? null,
            q.minDuration ?? null,
            q.maxDuration ?? null,
            q.minHeight ?? null,
            q.maxHeight ?? null,
            q.limit,
            q.offset,
          ],
        )
      ).rows,
      offset: q.offset,
      limit: q.limit,
      filters: {
        search: q.search,
        status: q.status ?? null,
        privacy: q.privacy ?? null,
        createdAfter: q.createdAfter ?? null,
        createdBefore: q.createdBefore ?? null,
        minDuration: q.minDuration ?? null,
        maxDuration: q.maxDuration ?? null,
        minHeight: q.minHeight ?? null,
        maxHeight: q.maxHeight ?? null,
        sort: q.sort,
      },
    };
  });

  app.get<{ Params: { id: string } }>("/api/v1/videos/:id", async (req) => {
    const v = await videoAccess(req, req.params.id);
    return {
      ...v,
      subtitles: (
        await db.query(
          "SELECT id,language,label,is_default,forced FROM subtitles WHERE video_id=$1",
          [v.id],
        )
      ).rows,
    };
  });

  app.patch<{ Params: { id: string } }>("/api/v1/videos/:id", async (req) => {
    const v = await videoAccess(req, req.params.id, "editor", "videos:write");
    const b = z
      .object({
        title: z.string().trim().min(1).max(200),
        description: z.string().max(10000).default(""),
        privacy: z.enum(["private", "unlisted", "public"]),
        tags: z.array(z.string().max(50)).max(30).default([]),
      })
      .parse(req.body);
    const a = await access(req, v.workspace_id, "editor", "videos:write");
    await db.query(
      "UPDATE videos SET title=$1,description=$2,privacy=$3,tags=$4,updated_at=now() WHERE id=$5",
      [b.title, b.description, b.privacy, b.tags, v.id],
    );
    await audit(v.workspace_id, a, "video.updated", v.id);
    return { ok: true };
  });

  app.put<{ Params: { id: string } }>(
    "/api/v1/videos/:id/transcoding-profile",
    async (req) => {
      const v = await videoAccess(req, req.params.id, "editor", "videos:write");
      const { profile } = z
        .object({ profile: transcodingProfileSchema })
        .parse(req.body);
      const a = await access(req, v.workspace_id, "editor", "videos:write");
      const updated = await db.query(
        "UPDATE videos SET transcoding_profile=$1,updated_at=now() WHERE id=$2 AND status='queued' RETURNING transcoding_profile",
        [profile, v.id],
      );
      if (!updated.rowCount)
        throw new ApiError(409, "TRANSCODING_PROFILE_LOCKED");
      await audit(v.workspace_id, a, "video.transcoding_profile_updated", v.id);
      return { profile: updated.rows[0].transcoding_profile };
    },
  );

  app.put<{ Params: { id: string } }>(
    "/api/v1/videos/:id/embed-policy",
    async (req) => {
      const v = await videoAccess(req, req.params.id, "editor", "videos:write");
      const body = z
        .object({
          allowedOrigins: z
            .array(z.url().max(2048))
            .max(20)
            .default([]),
        })
        .parse(req.body);
      const allowedOrigins = Array.from(
        new Set(
          body.allowedOrigins.map((value) => {
            const url = new URL(value);
            if (!["http:", "https:"].includes(url.protocol))
              throw new ApiError(400, "INVALID_EMBED_ORIGIN");
            return url.origin;
          }),
        ),
      );
      const a = await access(req, v.workspace_id, "editor", "videos:write");
      await db.query(
        "UPDATE videos SET embed_allowed_origins=$1,updated_at=now() WHERE id=$2",
        [allowedOrigins, v.id],
      );
      await audit(v.workspace_id, a, "video.embed_policy_updated", v.id);
      return { allowedOrigins };
    },
  );

  app.delete<{ Params: { id: string } }>("/api/v1/videos/:id", async (req) => {
    const v = await videoAccess(req, req.params.id, "editor", "videos:write");
    const a = await access(req, v.workspace_id, "editor", "videos:write");
    const refs = await db.query(
      `SELECT 1
       FROM video_versions vv
       JOIN videos owner ON owner.id=vv.video_id
       WHERE vv.source_video_id=$1
         AND vv.video_id<>$1
         AND owner.deleted_at IS NULL
       LIMIT 1`,
      [v.id],
    );
    if (refs.rowCount) throw new ApiError(409, "VERSION_SOURCE_IN_USE");
    await transaction(async (c) => {
      await c.query(
        "UPDATE videos SET status='deleted',deleted_at=now() WHERE id=$1",
        [v.id],
      );
      await enqueue(c, "cleanup", { videoId: v.id });
      await event(c, v.workspace_id, v.id, "video.deleted");
    });
    await audit(v.workspace_id, a, "video.deleted", v.id);
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>(
    "/api/v1/videos/:id/retry",
    async (req) => {
      const v = await videoAccess(req, req.params.id, "editor", "videos:write");
      await transaction(async (c) => {
        const r = await c.query(
          "UPDATE videos SET status='queued',error_code=NULL WHERE id=$1 AND status='failed' RETURNING id",
          [v.id],
        );
        if (!r.rowCount) throw new ApiError(409, "VIDEO_NOT_FAILED");
        const u = await c.query(
          "SELECT id FROM uploads WHERE video_id=$1 AND status NOT IN ('expired','cancelled')",
          [v.id],
        );
        if (!u.rowCount) throw new ApiError(409, "UPLOAD_UNAVAILABLE");
        await enqueue(c, "media-probe", {
          videoId: v.id,
          uploadId: u.rows[0].id,
        });
      });
      return { ok: true };
    },
  );

  app.put<{ Params: { id: string } }>(
    "/api/v1/videos/:id/progress",
    async (req) => {
      await videoAccess(req, req.params.id);
      const a = await actor(req);
      if (!a.userId) throw new ApiError(403, "USER_REQUIRED");
      const b = z
        .object({ position: z.number().min(0).max(86400) })
        .parse(req.body);
      await db.query(
        "INSERT INTO watch_progress VALUES($1,$2,$3,now()) ON CONFLICT(user_id,video_id) DO UPDATE SET position=$3,updated_at=now()",
        [a.userId, req.params.id, b.position],
      );
      return { ok: true };
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/v1/videos/:id/progress",
    async (req) => {
      await videoAccess(req, req.params.id);
      const a = await actor(req);
      return (
        (
          await db.query(
            "SELECT position FROM watch_progress WHERE user_id=$1 AND video_id=$2",
            [a.userId, req.params.id],
          )
        ).rows[0] ?? { position: 0 }
      );
    },
  );
}
