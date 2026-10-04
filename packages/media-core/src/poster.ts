import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { run } from "./index.js";

export async function posterFrame(
  source: string,
  output: string,
  timeSeconds: number,
) {
  if (!Number.isFinite(timeSeconds) || timeSeconds < 0)
    throw Error("INVALID_POSTER_TIME");
  await mkdir(output, { recursive: true });
  const target = join(output, "poster.jpg");
  await run(
    "ffmpeg",
    [
      "-v",
      "error",
      "-nostdin",
      "-y",
      "-protocol_whitelist",
      "file",
      "-format_whitelist",
      "mov,matroska,webm",
      "-ss",
      String(timeSeconds),
      "-i",
      source,
      "-frames:v",
      "1",
      "-vf",
      "scale='min(1280,iw)':-2",
      "-q:v",
      "2",
      target,
    ],
    60000,
  );
  return target;
}
