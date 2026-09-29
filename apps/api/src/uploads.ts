import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db, transaction } from "../../../packages/shared/src/db.js";
import { storage, videoPrefix } from "../../../packages/shared/src/storage.js";
import {
  hash,
  expectedPartSize,
} from "../../../packages/shared/src/security.js";
import { enqueue, event } from "../../../packages/shared/src/events.js";
import { config } from "../../../packages/config/src/index.js";
import { access, ApiError, uuid } from "./context.js";
export async function uploadRoutes(app: FastifyInstance) {
  app.addContentTypeParser(
    "application/octet-stream",
    { parseAs: "buffer", bodyLimit: 8388608 },
    (_r, b, done) => done(null, b),
  );
  app.post("/api/v1/uploads", async (req, reply) => {
    const b = z
      .object({
        workspaceId: uuid,
        videoId: uuid,
        filename: z.string().min(1).max(255),
        mimeType: z.enum([
          "video/mp4",
          "video/quicktime",
          "video/webm",
          "video/x-matroska",
        ]),
        totalSize: z
          .number()
          .int()
          .positive()
          .max(config.MAX_UPLOAD_SIZE_GB * 1024 ** 3),
        checksum: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .parse(req.body);
    await access(req, b.workspaceId, "editor", "uploads:write");
    return reply.code(201).send(
      await transaction(async (c) => {
        const w = (
          await c.query("SELECT * FROM workspaces WHERE id=$1 FOR UPDATE", [
            b.workspaceId,
          ])
        ).rows[0];
        const used = (
          await c.query(
            "SELECT coalesce(sum(size),0) AS bytes FROM videos WHERE workspace_id=$1 AND deleted_at IS NULL",
            [b.workspaceId],
          )
        ).rows[0];
        if (Number(used.bytes) + b.totalSize > Number(w.storage_limit))
          throw new ApiError(409, "STORAGE_QUOTA_EXCEEDED");
        const v = await c.query(
          "UPDATE videos SET status='uploading',filename=$1,size=$2 WHERE id=$3 AND workspace_id=$4 AND status='draft' RETURNING id",
          [b.filename, b.totalSize, b.videoId, b.workspaceId],
        );
        if (!v.rowCount) throw new ApiError(409, "VIDEO_NOT_DRAFT");
        const r = await c.query(
          "INSERT INTO uploads(workspace_id,video_id,filename,mime_type,total_size,checksum,expires_at) VALUES($1,$2,$3,$4,$5,$6,now()+$7*interval '1 hour') RETURNING *",
          [
            b.workspaceId,
            b.videoId,
            b.filename,
            b.mimeType,
            b.totalSize,
            b.checksum,
            config.UPLOAD_TTL_HOURS,
          ],
        );
        await event(c, b.workspaceId, b.videoId, "video.upload.started");
        return r.rows[0];
      }),
    );
  });
  app.get<{ Params: { id: string } }>("/api/v1/uploads/:id", async (req) => {
    uuid.parse(req.params.id);
    const r = await db.query("SELECT * FROM uploads WHERE id=$1", [
      req.params.id,
    ]);
    if (!r.rowCount) throw new ApiError(404, "UPLOAD_NOT_FOUND");
    await access(req, r.rows[0].workspace_id, "editor", "uploads:write");
    return {
      ...r.rows[0],
      parts: (
        await db.query(
          "SELECT part_number,size,checksum FROM upload_parts WHERE upload_id=$1 ORDER BY part_number",
          [req.params.id],
        )
      ).rows,
    };
  });
  app.put<{ Params: { id: string; part: string } }>(
    "/api/v1/uploads/:id/parts/:part",
    { bodyLimit: 8388608 },
    async (req) => {
      uuid.parse(req.params.id);
      const part = z.coerce.number().int().min(0).parse(req.params.part);
      const checksum = z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .parse(req.headers["x-checksum-sha256"]);
      const body = req.body as Buffer;
      if (!Buffer.isBuffer(body) || hash(body) !== checksum)
        throw new ApiError(422, "CHECKSUM_MISMATCH");
      const initial = await db.query(
        "SELECT workspace_id FROM uploads WHERE id=$1",
        [req.params.id],
      );
      if (!initial.rowCount) throw new ApiError(404, "UPLOAD_NOT_FOUND");
      await access(
        req,
        initial.rows[0].workspace_id,
        "editor",
        "uploads:write",
      );
      return transaction(async (c) => {
        const u = (
          await c.query("SELECT * FROM uploads WHERE id=$1 FOR UPDATE", [
            req.params.id,
          ])
        ).rows[0];
        if (u.status !== "uploading" || new Date(u.expires_at) < new Date())
          throw new ApiError(409, "UPLOAD_CLOSED");
        let size: number;
        try {
          size = expectedPartSize(Number(u.total_size), u.chunk_size, part);
        } catch {
          throw new ApiError(400, "INVALID_PART");
        }
        if (body.length !== size) throw new ApiError(422, "INVALID_PART_SIZE");
        const existing = await c.query(
          "SELECT checksum FROM upload_parts WHERE upload_id=$1 AND part_number=$2",
          [u.id, part],
        );
        if (existing.rowCount) {
          if (existing.rows[0].checksum !== checksum)
            throw new ApiError(409, "PART_CONFLICT");
          return { uploadedBytes: Number(u.uploaded_bytes) };
        }
        const key = `${videoPrefix(u.workspace_id, u.video_id)}parts/${part}`;
        await storage.put(key, body);
        await c.query("INSERT INTO upload_parts VALUES($1,$2,$3,$4,$5)", [
          u.id,
          part,
          key,
          size,
          checksum,
        ]);
        const updated = await c.query(
          "UPDATE uploads SET uploaded_bytes=uploaded_bytes+$1 WHERE id=$2 RETURNING uploaded_bytes",
          [size, u.id],
        );
        return { uploadedBytes: Number(updated.rows[0].uploaded_bytes) };
      });
    },
  );
  app.post<{ Params: { id: string } }>(
    "/api/v1/uploads/:id/complete",
    async (req) => {
      uuid.parse(req.params.id);
      const initial = await db.query(
        "SELECT workspace_id FROM uploads WHERE id=$1",
        [req.params.id],
      );
      if (!initial.rowCount) throw new ApiError(404, "UPLOAD_NOT_FOUND");
      await access(
        req,
        initial.rows[0].workspace_id,
        "editor",
        "uploads:write",
      );
      return transaction(async (c) => {
        const u = (
          await c.query("SELECT * FROM uploads WHERE id=$1 FOR UPDATE", [
            req.params.id,
          ])
        ).rows[0];
        if (["complete", "finalizing"].includes(u.status))
          return { status: u.status };
        if (
          u.status !== "uploading" ||
          new Date(u.expires_at) < new Date() ||
          u.uploaded_bytes !== u.total_size
        )
          throw new ApiError(409, "UPLOAD_INCOMPLETE");
        await c.query("UPDATE uploads SET status='finalizing' WHERE id=$1", [
          u.id,
        ]);
        await c.query("UPDATE videos SET status='queued' WHERE id=$1", [
          u.video_id,
        ]);
        await enqueue(c, "media-probe", {
          videoId: u.video_id,
          uploadId: u.id,
        });
        return { status: "finalizing" };
      });
    },
  );
  app.delete<{ Params: { id: string } }>("/api/v1/uploads/:id", async (req) => {
    uuid.parse(req.params.id);
    const r = await db.query("SELECT * FROM uploads WHERE id=$1", [
      req.params.id,
    ]);
    if (!r.rowCount) throw new ApiError(404, "UPLOAD_NOT_FOUND");
    const u = r.rows[0];
    await access(req, u.workspace_id, "editor", "uploads:write");
    await transaction(async (c) => {
      const cancelled = await c.query(
        "UPDATE uploads SET status='cancelled' WHERE id=$1 AND status='uploading' RETURNING id",
        [u.id],
      );
      if (!cancelled.rowCount) throw new ApiError(409, "UPLOAD_CLOSED");
      await c.query(
        "UPDATE videos SET status='deleted',deleted_at=now() WHERE id=$1",
        [u.video_id],
      );
      await enqueue(c, "cleanup", { videoId: u.video_id });
    });
    return { ok: true };
  });
}
