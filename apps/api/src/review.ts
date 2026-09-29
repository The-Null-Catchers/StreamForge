import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db, transaction } from "../../../packages/shared/src/db.js";
import {
  access,
  actor,
  audit,
  videoAccess,
  uuid,
  ApiError,
} from "./context.js";

async function requireUser(req: Parameters<typeof actor>[0]) {
  const a = await actor(req);
  if (!a.userId) throw new ApiError(403, "USER_REQUIRED");
  return a;
}

export async function reviewRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string } }>(
    "/api/v1/videos/:id/versions",
    async (req) => {
      const video = await videoAccess(req, req.params.id);
      return (
        await db.query(
          `SELECT id,version_number,label,source_video_id,filename,checksum,size,metadata,renditions,created_by,created_at,
                  (id=$2::uuid) AS active
           FROM video_versions
           WHERE video_id=$1
           ORDER BY version_number DESC`,
          [video.id, video.active_version_id],
        )
      ).rows;
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/v1/videos/:id/versions",
    async (req, reply) => {
      const video = await videoAccess(
        req,
        req.params.id,
        "editor",
        "videos:write",
      );
      const body = z
        .object({
          sourceVideoId: uuid,
          label: z.string().trim().max(200).default(""),
        })
        .parse(req.body);
      const source = await videoAccess(
        req,
        body.sourceVideoId,
        "editor",
        "videos:write",
      );
      if (source.workspace_id !== video.workspace_id)
        throw new ApiError(400, "VERSION_SOURCE_WORKSPACE_MISMATCH");
      if (source.id === video.id)
        throw new ApiError(409, "VERSION_SOURCE_SAME_VIDEO");
      if (source.status !== "ready")
        throw new ApiError(409, "VERSION_SOURCE_NOT_READY");

      const a = await access(
        req,
        video.workspace_id,
        "editor",
        "videos:write",
      );
      const created = await transaction(async (c) => {
        await c.query("SELECT id FROM videos WHERE id=$1 FOR UPDATE", [video.id]);
        const existing = Number(
          (
            await c.query(
              "SELECT count(*) AS n FROM video_versions WHERE video_id=$1",
              [video.id],
            )
          ).rows[0].n,
        );
        if (existing === 0) {
          const baseline = (
            await c.query(
              `INSERT INTO video_versions(
                 video_id,version_number,label,source_video_id,source_key,output_prefix,
                 filename,checksum,size,metadata,renditions,created_by
               ) VALUES($1,1,$2,$1,$3,$4,$5,$6,$7,$8,$9,$10)
               RETURNING id`,
              [
                video.id,
                "Initial version",
                video.source_key,
                video.output_prefix,
                video.filename,
                video.checksum,
                video.size,
                video.metadata,
                video.renditions,
                a.userId ?? a.keyId,
              ],
            )
          ).rows[0];
          await c.query(
            "UPDATE videos SET active_version_id=$1 WHERE id=$2 AND active_version_id IS NULL",
            [baseline.id, video.id],
          );
        }
        const next = (
          await c.query(
            "SELECT COALESCE(max(version_number),0)+1 AS n FROM video_versions WHERE video_id=$1",
            [video.id],
          )
        ).rows[0].n;
        return (
          await c.query(
            `INSERT INTO video_versions(
               video_id,version_number,label,source_video_id,source_key,output_prefix,
               filename,checksum,size,metadata,renditions,created_by
             ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
             RETURNING id,version_number,label,source_video_id,filename,checksum,size,metadata,renditions,created_by,created_at`,
            [
              video.id,
              next,
              body.label || `Version ${next}`,
              source.id,
              source.source_key,
              source.output_prefix,
              source.filename,
              source.checksum,
              source.size,
              source.metadata,
              source.renditions,
              a.userId ?? a.keyId,
            ],
          )
        ).rows[0];
      });
      await audit(video.workspace_id, a, "video.version.created", created.id);
      return reply.code(201).send(created);
    },
  );

  app.delete<{ Params: { id: string; versionId: string } }>(
    "/api/v1/videos/:id/versions/:versionId",
    async (req) => {
      const video = await videoAccess(
        req,
        req.params.id,
        "editor",
        "videos:write",
      );
      uuid.parse(req.params.versionId);
      if (video.active_version_id === req.params.versionId)
        throw new ApiError(409, "ACTIVE_VERSION_CANNOT_BE_DELETED");
      const a = await access(
        req,
        video.workspace_id,
        "editor",
        "videos:write",
      );
      const result = await db.query(
        "DELETE FROM video_versions WHERE id=$1 AND video_id=$2 RETURNING id",
        [req.params.versionId, video.id],
      );
      if (!result.rowCount) throw new ApiError(404, "VERSION_NOT_FOUND");
      await audit(video.workspace_id, a, "video.version.deleted", req.params.versionId);
      return { ok: true };
    },
  );

  app.put<{ Params: { id: string; versionId: string } }>(
    "/api/v1/videos/:id/versions/:versionId/activate",
    async (req) => {
      const video = await videoAccess(
        req,
        req.params.id,
        "editor",
        "videos:write",
      );
      uuid.parse(req.params.versionId);
      const version = (
        await db.query(
          "SELECT * FROM video_versions WHERE id=$1 AND video_id=$2",
          [req.params.versionId, video.id],
        )
      ).rows[0];
      if (!version) throw new ApiError(404, "VERSION_NOT_FOUND");
      const a = await access(
        req,
        video.workspace_id,
        "editor",
        "videos:write",
      );
      await db.query(
        `UPDATE videos
         SET active_version_id=$1,source_key=$2,output_prefix=$3,filename=$4,
             checksum=$5,size=$6,metadata=$7,renditions=$8,status='ready',
             error_code=NULL,updated_at=now()
         WHERE id=$9`,
        [
          version.id,
          version.source_key,
          version.output_prefix,
          version.filename,
          version.checksum,
          version.size,
          version.metadata,
          version.renditions,
          video.id,
        ],
      );
      await audit(video.workspace_id, a, "video.version.activated", version.id);
      return { ok: true, activeVersionId: version.id };
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/v1/videos/:id/review-comments",
    async (req) => {
      await videoAccess(req, req.params.id);
      return (
        await db.query(
          `SELECT c.id,c.video_id,c.version_id,c.parent_id,c.author_id,
                  u.email AS author_email,c.timestamp_seconds,c.body,
                  c.resolved_at,c.resolved_by,c.created_at,c.updated_at
           FROM review_comments c
           JOIN users u ON u.id=c.author_id
           WHERE c.video_id=$1
           ORDER BY c.created_at,c.id`,
          [req.params.id],
        )
      ).rows;
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/v1/videos/:id/review-comments",
    async (req, reply) => {
      const video = await videoAccess(req, req.params.id);
      const a = await requireUser(req);
      const body = z
        .object({
          versionId: uuid.optional(),
          parentId: uuid.optional(),
          timestampSeconds: z.number().finite().min(0).max(86400).optional(),
          body: z.string().trim().min(1).max(5000),
        })
        .parse(req.body);
      const versionId = body.versionId ?? video.active_version_id;
      if (versionId) {
        const r = await db.query(
          "SELECT 1 FROM video_versions WHERE id=$1 AND video_id=$2",
          [versionId, video.id],
        );
        if (!r.rowCount) throw new ApiError(400, "REVIEW_VERSION_INVALID");
      }
      if (body.parentId) {
        const parent = (
          await db.query(
            "SELECT video_id,version_id FROM review_comments WHERE id=$1",
            [body.parentId],
          )
        ).rows[0];
        if (!parent || parent.video_id !== video.id)
          throw new ApiError(400, "REVIEW_PARENT_INVALID");
        if (versionId && parent.version_id && parent.version_id !== versionId)
          throw new ApiError(400, "REVIEW_PARENT_VERSION_MISMATCH");
      }
      const created = (
        await db.query(
          `INSERT INTO review_comments(
             video_id,version_id,parent_id,author_id,timestamp_seconds,body
           ) VALUES($1,$2,$3,$4,$5,$6)
           RETURNING *`,
          [
            video.id,
            versionId,
            body.parentId ?? null,
            a.userId,
            body.timestampSeconds ?? null,
            body.body,
          ],
        )
      ).rows[0];
      await audit(video.workspace_id, a, "review.comment.created", created.id);
      return reply.code(201).send(created);
    },
  );

  app.patch<{ Params: { id: string; commentId: string } }>(
    "/api/v1/videos/:id/review-comments/:commentId",
    async (req) => {
      const video = await videoAccess(
        req,
        req.params.id,
        "editor",
        "videos:write",
      );
      uuid.parse(req.params.commentId);
      const body = z.object({ resolved: z.boolean() }).parse(req.body);
      const a = await requireUser(req);
      await access(req, video.workspace_id, "editor", "videos:write");
      const result = await db.query(
        `UPDATE review_comments
         SET resolved_at=CASE WHEN $1 THEN now() ELSE NULL END,
             resolved_by=CASE WHEN $1 THEN $2::uuid ELSE NULL END,
             updated_at=now()
         WHERE id=$3 AND video_id=$4
         RETURNING id`,
        [body.resolved, a.userId, req.params.commentId, video.id],
      );
      if (!result.rowCount) throw new ApiError(404, "REVIEW_COMMENT_NOT_FOUND");
      await audit(
        video.workspace_id,
        a,
        body.resolved ? "review.comment.resolved" : "review.comment.reopened",
        req.params.commentId,
      );
      return { ok: true };
    },
  );

  app.put<{ Params: { id: string } }>(
    "/api/v1/videos/:id/review-status",
    async (req) => {
      const video = await videoAccess(
        req,
        req.params.id,
        "editor",
        "videos:write",
      );
      const body = z
        .object({
          status: z.enum(["pending", "approved", "changes_requested"]),
        })
        .parse(req.body);
      const a = await access(
        req,
        video.workspace_id,
        "editor",
        "videos:write",
      );
      await db.query(
        "UPDATE videos SET review_status=$1,updated_at=now() WHERE id=$2",
        [body.status, video.id],
      );
      await audit(video.workspace_id, a, "review.status.updated", video.id);
      return { ok: true, status: body.status };
    },
  );
}
