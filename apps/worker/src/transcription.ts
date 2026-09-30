import type { Job } from "bullmq";
import { createWriteStream } from "node:fs";
import { mkdtemp, mkdir, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { db, transaction } from "../../../packages/shared/src/db.js";
import { storage } from "../../../packages/shared/src/storage.js";
import { run } from "../../../packages/media-core/src/index.js";
import {
  transcriptionProvider,
  transcriptionVtt,
  type TranscriptionSegment,
} from "../../../packages/transcription/src/index.js";
import { config } from "../../../packages/config/src/index.js";

export async function transcriptionJob(job: Job) {
  const { transcriptionId, videoId } = job.data as {
    transcriptionId: string;
    videoId: string;
  };
  const record = (
    await db.query(
      `SELECT
         t.*,v.workspace_id,v.source_key,v.metadata,v.deleted_at
       FROM transcriptions t
       JOIN videos v ON v.id=t.video_id
       WHERE t.id=$1 AND t.video_id=$2`,
      [transcriptionId, videoId],
    )
  ).rows[0];
  if (!record || record.deleted_at || record.status === "complete") return;
  if (!record.metadata?.hasAudio) throw Error("NO_AUDIO_STREAM");

  await db.query(
    `UPDATE transcriptions
     SET status='running',started_at=coalesce(started_at,now()),
         progress=greatest(progress,1),error_code=NULL,updated_at=now()
     WHERE id=$1`,
    [transcriptionId],
  );

  const dir = await mkdtemp(join(tmpdir(), "streamforge-transcription-"));
  try {
    const source = join(dir, "source.bin");
    const chunks = join(dir, "chunks");
    await mkdir(chunks);
    await pipeline(await storage.get(record.source_key), createWriteStream(source));

    await run(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-y",
        "-protocol_whitelist",
        "file",
        "-format_whitelist",
        "mov,matroska,webm",
        "-i",
        source,
        "-map",
        "0:a:0",
        "-vn",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-b:a",
        "48k",
        "-f",
        "segment",
        "-segment_time",
        String(config.TRANSCRIPTION_CHUNK_SECONDS),
        "-reset_timestamps",
        "1",
        join(chunks, "chunk-%04d.mp3"),
      ],
      7200000,
    );

    const files = (await readdir(chunks))
      .filter((name) => /^chunk-\d+\.mp3$/.test(name))
      .sort();
    if (!files.length) throw Error("NO_AUDIO_STREAM");

    const provider = transcriptionProvider(config.TRANSCRIPTION_PROVIDER, {
      baseUrl: config.TRANSCRIPTION_BASE_URL,
      apiKey: config.TRANSCRIPTION_API_KEY!,
      model: config.TRANSCRIPTION_MODEL,
    });
    const segments: TranscriptionSegment[] = [];
    let detectedLanguage: string | undefined;
    for (let index = 0; index < files.length; index++) {
      const result = await provider.transcribe(
        join(chunks, files[index]!),
        record.language === "auto" ? undefined : record.language,
      );
      detectedLanguage ||= result.language;
      const offset = index * config.TRANSCRIPTION_CHUNK_SECONDS;
      segments.push(
        ...result.segments.map((segment) => ({
          start: segment.start + offset,
          end: segment.end + offset,
          text: segment.text,
        })),
      );
      await db.query(
        `UPDATE transcriptions
         SET progress=$2,updated_at=now()
         WHERE id=$1`,
        [
          transcriptionId,
          Math.min(95, Math.round(((index + 1) / files.length) * 90) + 5),
        ],
      );
      await job.updateProgress({
        chunk: index + 1,
        chunks: files.length,
      });
    }

    const language =
      record.language === "auto"
        ? detectedLanguage?.toLowerCase().startsWith("ar")
          ? "ar"
          : "en"
        : record.language;
    const subtitleId = crypto.randomUUID();
    const key = `workspaces/${record.workspace_id}/videos/${videoId}/subtitles/${subtitleId}.vtt`;
    const vtt = transcriptionVtt(segments);
    await storage.put(key, Buffer.from(vtt), "text/vtt");

    await transaction(async (client) => {
      await client.query(
        `INSERT INTO subtitles(
           id,video_id,language,label,object_key,is_default,forced
         ) VALUES($1,$2,$3,$4,$5,false,false)`,
        [
          subtitleId,
          videoId,
          language,
          language === "ar" ? "العربية (تلقائي)" : "English (automatic)",
          key,
        ],
      );
      await client.query(
        `INSERT INTO transcript_segments(
           video_id,subtitle_id,language,start_seconds,end_seconds,text
         )
         SELECT $1,$2,$3,start_seconds,end_seconds,text
         FROM unnest($4::float8[],$5::float8[],$6::text[])
           AS cue(start_seconds,end_seconds,text)`,
        [
          videoId,
          subtitleId,
          language,
          segments.map((segment) => segment.start),
          segments.map((segment) => segment.end),
          segments.map((segment) => segment.text),
        ],
      );
      await client.query(
        `UPDATE transcriptions
         SET status='complete',progress=100,subtitle_id=$2,
             completed_at=now(),updated_at=now(),error_code=NULL
         WHERE id=$1`,
        [transcriptionId, subtitleId],
      );
      await client.query(
        `INSERT INTO notifications(workspace_id,video_id,message)
         VALUES($1,$2,$3)`,
        [
          record.workspace_id,
          videoId,
          language === "ar"
            ? "اكتمل النسخ التلقائي للفيديو."
            : "Automatic transcription completed.",
        ],
      );
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
