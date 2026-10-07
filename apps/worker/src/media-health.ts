import { db, transaction } from "../../../packages/shared/src/db.js";
import { storage } from "../../../packages/shared/src/storage.js";
import { event } from "../../../packages/shared/src/events.js";

export type MediaHealthCursor = string | null;

type VideoRow = {
  id: string;
  workspace_id: string;
  output_prefix: string;
  metadata: unknown;
  renditions: Array<{ name: string }>;
};

function sourceAudioTrackCount(metadata: unknown) {
  const streams = (metadata as { raw?: { streams?: unknown[] } } | undefined)
    ?.raw?.streams;
  if (!Array.isArray(streams)) return 0;
  return streams.filter(
    (stream) =>
      typeof stream === "object" &&
      stream !== null &&
      (stream as { codec_type?: string }).codec_type === "audio",
  ).length;
}

async function storageText(key: string) {
  const stream = await storage.get(key);
  let text = "";
  for await (const chunk of stream) text += chunk.toString();
  return text;
}

function safeMediaReference(reference: string) {
  const clean = reference.split(/[?#]/, 1)[0];
  if (
    !clean ||
    clean.startsWith("/") ||
    /^[a-z][a-z0-9+.-]*:/i.test(clean) ||
    clean.split("/").includes("..") ||
    !/^[A-Za-z0-9._/-]+$/.test(clean) ||
    ![".ts", ".m4s", ".mp4"].some((ext) => clean.endsWith(ext))
  )
    throw Error("MEDIA_INTEGRITY_FAILED");
  return clean;
}

async function verifyStoredMediaPlaylist(
  playlistKey: string,
  segmentExtension: ".ts" | ".m4s",
) {
  if (!(await storage.exists(playlistKey)) || (await storage.size(playlistKey)) <= 0)
    throw Error("MEDIA_INTEGRITY_FAILED");
  const text = await storageText(playlistKey);
  if (!text.startsWith("#EXTM3U") || !text.includes("#EXT-X-ENDLIST"))
    throw Error("MEDIA_INTEGRITY_FAILED");
  if (segmentExtension === ".m4s" && !text.includes("#EXT-X-MAP:"))
    throw Error("MEDIA_INTEGRITY_FAILED");

  const references = new Set<string>();
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    if (!line.startsWith("#")) references.add(line);
    for (const match of line.matchAll(/URI="([^"]+)"/g)) references.add(match[1]);
  }
  const segments = [...references].filter((reference) =>
    reference.split(/[?#]/, 1)[0].endsWith(segmentExtension),
  );
  if (!segments.length) throw Error("MEDIA_INTEGRITY_FAILED");

  const directory = playlistKey.slice(0, playlistKey.lastIndexOf("/") + 1);
  for (const reference of references) {
    const key = directory + safeMediaReference(reference);
    if (!(await storage.exists(key)) || (await storage.size(key)) <= 0)
      throw Error("MEDIA_INTEGRITY_FAILED");
  }
}

export async function verifyReadyVideoMedia(video: VideoRow) {
  const required = [
    "hls/master.m3u8",
    "hls/cmaf/master.m3u8",
    "thumbnails/poster.jpg",
    "thumbnails/previews.vtt",
    "thumbnails/0001.jpg",
  ];
  for (const key of required) {
    const objectKey = video.output_prefix + key;
    if (!(await storage.exists(objectKey)) || (await storage.size(objectKey)) <= 0)
      throw Error("MEDIA_INTEGRITY_FAILED");
  }

  for (const rendition of video.renditions ?? []) {
    await verifyStoredMediaPlaylist(
      video.output_prefix + `hls/${rendition.name}/index.m3u8`,
      ".ts",
    );
    await verifyStoredMediaPlaylist(
      video.output_prefix + `hls/cmaf/${rendition.name}/index.m3u8`,
      ".m4s",
    );
  }

  const audioTracks = sourceAudioTrackCount(video.metadata);
  for (let ordinal = 1; ordinal <= audioTracks; ordinal++) {
    await verifyStoredMediaPlaylist(
      video.output_prefix + `hls/audio/track-${ordinal}/index.m3u8`,
      ".ts",
    );
    await verifyStoredMediaPlaylist(
      video.output_prefix + `hls/cmaf/audio/track-${ordinal}/index.m3u8`,
      ".m4s",
    );
  }
}

export async function scanReadyVideoMediaHealth(
  cursor: MediaHealthCursor,
  limit = 10,
) {
  const rows = (
    await db.query(
      `SELECT id,workspace_id,output_prefix,metadata,renditions
       FROM videos
       WHERE deleted_at IS NULL
         AND status='ready'
         AND output_prefix IS NOT NULL
         AND ($1::uuid IS NULL OR id>$1::uuid)
       ORDER BY id
       LIMIT $2`,
      [cursor, limit],
    )
  ).rows as VideoRow[];

  let unhealthy = 0;
  for (const video of rows) {
    try {
      await verifyReadyVideoMedia(video);
    } catch {
      unhealthy++;
      await transaction(async (c) => {
        const changed = await c.query(
          `UPDATE videos
           SET status='failed',error_code='MEDIA_INTEGRITY_FAILED',updated_at=now()
           WHERE id=$1 AND status='ready' AND deleted_at IS NULL
           RETURNING id`,
          [video.id],
        );
        if (!changed.rowCount) return;
        await event(c, video.workspace_id, video.id, "video.media.integrity.failed");
        await c.query(
          "INSERT INTO notifications(workspace_id,video_id,message) VALUES($1,$2,$3)",
          [
            video.workspace_id,
            video.id,
            "Stored media integrity verification failed. Playback has been disabled until the media is repaired or reprocessed.",
          ],
        );
      });
    }
  }

  return {
    checked: rows.length,
    unhealthy,
    cursor: rows.length < limit ? null : rows.at(-1)?.id ?? null,
  };
}
