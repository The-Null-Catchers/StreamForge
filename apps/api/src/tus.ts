import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { db, transaction } from "../../../packages/shared/src/db.js";
import { storage, videoPrefix } from "../../../packages/shared/src/storage.js";
import { hash, expectedPartSize } from "../../../packages/shared/src/security.js";
import { enqueue, event } from "../../../packages/shared/src/events.js";
import { config } from "../../../packages/config/src/index.js";
import { access, ApiError, uuid } from "./context.js";

const TUS_VERSION = "1.0.0";
const TUS_HEADERS = {
  "Tus-Resumable": TUS_VERSION,
  "Tus-Version": TUS_VERSION,
  "Tus-Extension": "creation,termination",
  "Tus-Max-Size": String(config.MAX_UPLOAD_SIZE_GB * 1024 ** 3),
};

function tus(reply: FastifyReply) {
  for (const [name, value] of Object.entries(TUS_HEADERS)) reply.header(name, value);
  return reply;
}

function requireTus(req: FastifyRequest) {
  if (req.headers["tus-resumable"] !== TUS_VERSION)
    throw new ApiError(412, "TUS_VERSION_UNSUPPORTED");
}

function parseMetadata(raw: string | string[] | undefined) {
  if (!raw || Array.isArray(raw)) return new Map<string, string>();
  const metadata = new Map<string, string>();
  for (const entry of raw.split(",")) {
    const [key, encoded = ""] = entry.trim().split(" ", 2);
    if (!key) continue;
    metadata.set(key, Buffer.from(encoded, "base64").toString("utf8"));
  }
  return metadata;
}

const createMetadata = z.object({
  workspaceId: uuid,
  videoId: uuid,
  filename: z.string().min(1).max(255),
  mimeType: z.enum([
    "video/mp4",
    "video/quicktime",
    "video/webm",
    "video/x-matroska",
  ]),
  checksum: z.string().regex(/^[a-f0-9]{64}$/),
});

async function uploadRow(id: string) {
  const result = await db.query("SELECT * FROM uploads WHERE id=$1", [id]);
  if (!result.rowCount) throw new ApiError(404, "UPLOAD_NOT_FOUND");
  return result.rows[0];
}

export async function tusRoutes(app: FastifyInstance) {
  app.addContentTypeParser(
    "application/offset+octet-stream",
    { parseAs: "buffer", bodyLimit: 8388608 },
    (_req, body, done) => done(null, body),
  );

  app.options("/api/v1/tus", async (_req, reply) => tus(reply).code(204).send());
  app.options<{ Params: { id: string } }>(
    "/api/v1/tus/:id",
    async (_req, reply) => tus(reply).code(204).send(),
  );

  app.post("/api/v1/tus", async (req, reply) => {
    requireTus(req);
    const uploadLength = z.coerce
      .number()
      .int()
      .positive()
      .max(config.MAX_UPLOAD_SIZE_GB * 1024 ** 3)
      .parse(req.headers["upload-length"]);
    const metadata = parseMetadata(req.headers["upload-metadata"]);
    const parsed = createMetadata.parse(Object.fromEntries(metadata));
    await access(req, parsed.workspaceId, "editor", "uploads:write");

    const created = await transaction(async (c) => {
      const workspace = (
        await c.query("SELECT * FROM workspaces WHERE id=$1 FOR UPDATE", [parsed.workspaceId])
      ).rows[0];
      const used = (
        await c.query(
          "SELECT coalesce(sum(size),0) AS bytes FROM videos WHERE workspace_id=$1 AND deleted_at IS NULL",
          [parsed.workspaceId],
        )
      ).rows[0];
      if (Number(used.bytes) + uploadLength > Number(workspace.storage_limit))
        throw new ApiError(409, "STORAGE_QUOTA_EXCEEDED");

      const video = await c.query(
        "UPDATE videos SET status='uploading',filename=$1,size=$2 WHERE id=$3 AND workspace_id=$4 AND status='draft' RETURNING id",
        [parsed.filename, uploadLength, parsed.videoId, parsed.workspaceId],
      );
      if (!video.rowCount) throw new ApiError(409, "VIDEO_NOT_DRAFT");

      const row = await c.query(
        `INSERT INTO uploads(
           workspace_id,video_id,filename,mime_type,total_size,checksum,expires_at,upload_mode
         ) VALUES($1,$2,$3,$4,$5,$6,now()+$7*interval '1 hour','proxy')
         RETURNING *`,
        [
          parsed.workspaceId,
          parsed.videoId,
          parsed.filename,
          parsed.mimeType,
          uploadLength,
          parsed.checksum,
          config.UPLOAD_TTL_HOURS,
        ],
      );
      await event(c, parsed.workspaceId, parsed.videoId, "video.upload.started");
      return row.rows[0];
    });

    return tus(reply)
      .header("Location", `/api/v1/tus/${created.id}`)
      .header("Upload-Offset", "0")
      .code(201)
      .send();
  });

  app.head<{ Params: { id: string } }>("/api/v1/tus/:id", async (req, reply) => {
    requireTus(req);
    uuid.parse(req.params.id);
    const row = await uploadRow(req.params.id);
    await access(req, row.workspace_id, "editor", "uploads:write");
    if (row.upload_mode !== "proxy") throw new ApiError(409, "TUS_UPLOAD_REQUIRED");
    return tus(reply)
      .header("Upload-Offset", String(row.uploaded_bytes))
      .header("Upload-Length", String(row.total_size))
      .header(
        "Upload-Metadata",
        `filename ${Buffer.from(row.filename).toString("base64")},mimeType ${Buffer.from(row.mime_type).toString("base64")}`,
      )
      .code(204)
      .send();
  });

  app.patch<{ Params: { id: string } }>(
    "/api/v1/tus/:id",
    { bodyLimit: 8388608 },
    async (req, reply) => {
      requireTus(req);
      uuid.parse(req.params.id);
      const requestedOffset = z.coerce
        .number()
        .int()
        .min(0)
        .parse(req.headers["upload-offset"]);
      const body = req.body as Buffer;
      if (!Buffer.isBuffer(body) || !body.length)
        throw new ApiError(400, "EMPTY_UPLOAD_CHUNK");

      const initial = await uploadRow(req.params.id);
      await access(req, initial.workspace_id, "editor", "uploads:write");
      if (initial.upload_mode !== "proxy") throw new ApiError(409, "TUS_UPLOAD_REQUIRED");

      const nextOffset = await transaction(async (c) => {
        const row = (
          await c.query("SELECT * FROM uploads WHERE id=$1 FOR UPDATE", [req.params.id])
        ).rows[0];
        if (row.status !== "uploading" || new Date(row.expires_at) < new Date())
          throw new ApiError(409, "UPLOAD_CLOSED");
        if (Number(row.uploaded_bytes) !== requestedOffset)
          throw new ApiError(409, "UPLOAD_OFFSET_MISMATCH");

        const part = Math.floor(requestedOffset / Number(row.chunk_size));
        if (requestedOffset !== part * Number(row.chunk_size))
          throw new ApiError(409, "UPLOAD_OFFSET_MISMATCH");

        let expectedSize: number;
        try {
          expectedSize = expectedPartSize(Number(row.total_size), row.chunk_size, part);
        } catch {
          throw new ApiError(400, "INVALID_PART");
        }
        if (body.length !== expectedSize) throw new ApiError(422, "INVALID_PART_SIZE");

        const workspace = (
          await c.query(
            "SELECT upload_bytes_monthly_limit FROM workspaces WHERE id=$1 FOR UPDATE",
            [row.workspace_id],
          )
        ).rows[0];
        const monthly = (
          await c.query(
            `SELECT coalesce(sum(uploaded_bytes),0) AS bytes
             FROM uploads
             WHERE workspace_id=$1
               AND id<>$2
               AND created_at>=date_trunc('month',now())`,
            [row.workspace_id, row.id],
          )
        ).rows[0];
        if (
          Number(monthly.bytes) + Number(row.uploaded_bytes) + body.length >
          Number(workspace.upload_bytes_monthly_limit)
        )
          throw new ApiError(409, "MONTHLY_UPLOAD_QUOTA_EXCEEDED");

        const checksum = hash(body);
        const key = `${videoPrefix(row.workspace_id, row.video_id)}parts/${part}`;
        await storage.put(key, body);
        await c.query(
          `INSERT INTO upload_parts(upload_id,part_number,object_key,size,checksum)
           VALUES($1,$2,$3,$4,$5)
           ON CONFLICT(upload_id,part_number) DO UPDATE
           SET object_key=excluded.object_key,size=excluded.size,checksum=excluded.checksum`,
          [row.id, part, key, body.length, checksum],
        );
        const updated = await c.query(
          "UPDATE uploads SET uploaded_bytes=uploaded_bytes+$1 WHERE id=$2 RETURNING uploaded_bytes,total_size,video_id",
          [body.length, row.id],
        );
        const uploadedBytes = Number(updated.rows[0].uploaded_bytes);
        if (uploadedBytes === Number(updated.rows[0].total_size)) {
          await c.query("UPDATE uploads SET status='finalizing' WHERE id=$1", [row.id]);
          await c.query("UPDATE videos SET status='queued' WHERE id=$1", [updated.rows[0].video_id]);
          await enqueue(c, "media-probe", {
            videoId: updated.rows[0].video_id,
            uploadId: row.id,
          });
        }
        return uploadedBytes;
      });

      return tus(reply).header("Upload-Offset", String(nextOffset)).code(204).send();
    },
  );

  app.delete<{ Params: { id: string } }>("/api/v1/tus/:id", async (req, reply) => {
    requireTus(req);
    uuid.parse(req.params.id);
    const row = await uploadRow(req.params.id);
    await access(req, row.workspace_id, "editor", "uploads:write");
    if (row.upload_mode !== "proxy") throw new ApiError(409, "TUS_UPLOAD_REQUIRED");
    await transaction(async (c) => {
      const cancelled = await c.query(
        "UPDATE uploads SET status='cancelled' WHERE id=$1 AND status='uploading' RETURNING video_id",
        [row.id],
      );
      if (!cancelled.rowCount) throw new ApiError(409, "UPLOAD_CLOSED");
      await c.query("UPDATE videos SET status='deleted',deleted_at=now() WHERE id=$1", [
        cancelled.rows[0].video_id,
      ]);
      await enqueue(c, "cleanup", { videoId: cancelled.rows[0].video_id });
    });
    return tus(reply).code(204).send();
  });
}
