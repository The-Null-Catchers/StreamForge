import type { Job } from "bullmq";
import { db } from "../../../packages/shared/src/db.js";
import { config } from "../../../packages/config/src/index.js";
import { generateMediaHelpers } from "../../../packages/ai/src/index.js";

function stamp(seconds: number) {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  return [hours, minutes, secs].map((value) => String(value).padStart(2, "0")).join(":");
}

export async function aiGenerationJob(job: Job) {
  const { generationId, videoId } = job.data as {
    generationId: string;
    videoId: string;
  };
  const generation = (
    await db.query(
      `SELECT
         g.*,v.title,v.metadata,v.deleted_at
       FROM ai_generations g
       JOIN videos v ON v.id=g.video_id
       WHERE g.id=$1 AND g.video_id=$2`,
      [generationId, videoId],
    )
  ).rows[0];
  if (!generation || generation.deleted_at || generation.status === "complete")
    return;

  await db.query(
    `UPDATE ai_generations
     SET status='running',started_at=coalesce(started_at,now()),
         error_code=NULL,updated_at=now()
     WHERE id=$1`,
    [generationId],
  );

  const rows = (
    await db.query(
      `SELECT start_seconds,text
       FROM transcript_segments
       WHERE video_id=$1
       ORDER BY start_seconds,id`,
      [videoId],
    )
  ).rows;
  if (!rows.length) throw Error("TRANSCRIPT_REQUIRED");

  let transcript = "";
  for (const row of rows) {
    const line = `[${stamp(Number(row.start_seconds))}] ${row.text}\n`;
    if (transcript.length + line.length > config.AI_MAX_TRANSCRIPT_CHARS) break;
    transcript += line;
  }
  if (!transcript.trim()) throw Error("TRANSCRIPT_REQUIRED");

  const result = await generateMediaHelpers(
    {
      baseUrl: config.AI_BASE_URL,
      apiKey: config.AI_API_KEY!,
      model: config.AI_MODEL,
    },
    {
      kind: generation.kind,
      language: generation.language,
      transcript,
      duration: Number(generation.metadata?.duration ?? 0),
      currentTitle: generation.title,
    },
  );

  await db.query(
    `UPDATE ai_generations
     SET status='complete',result=$2,completed_at=now(),updated_at=now()
     WHERE id=$1`,
    [generationId, JSON.stringify(result)],
  );
}
