import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { run } from "./index.js";

const TILE_WIDTH = 240;
const TILE_HEIGHT = 135;
const COLUMNS = 5;
const ROWS = 5;
const FRAMES_PER_SHEET = COLUMNS * ROWS;
const MAX_FRAMES = 60;

function stamp(seconds: number) {
  return new Date(Math.floor(seconds * 1000)).toISOString().slice(11, 23);
}

export async function spriteThumbnails(
  source: string,
  output: string,
  duration: number,
) {
  await mkdir(output, { recursive: true });

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
      String(Math.min(duration / 4, 5)),
      "-i",
      source,
      "-frames:v",
      "1",
      "-vf",
      "scale='min(1280,iw)':-2",
      join(output, "poster.jpg"),
    ],
    60000,
  );

  const interval = Math.max(1, duration / MAX_FRAMES);
  const frameCount = Math.max(1, Math.min(MAX_FRAMES, Math.ceil(duration / interval)));
  const filter = [
    `fps=1/${interval}`,
    `scale=w='if(gt(a,${TILE_WIDTH}/${TILE_HEIGHT}),${TILE_WIDTH},trunc(${TILE_HEIGHT}*a))':h='if(gt(a,${TILE_WIDTH}/${TILE_HEIGHT}),trunc(${TILE_WIDTH}/a),${TILE_HEIGHT})'`,
    "setsar=1",
    `pad=${TILE_WIDTH}:${TILE_HEIGHT}:(ow-iw)/2:(oh-ih)/2`,
    `tile=${COLUMNS}x${ROWS}`,
  ].join(",");

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
      "-i",
      source,
      "-vf",
      filter,
      "-frames:v",
      String(Math.ceil(frameCount / FRAMES_PER_SHEET)),
      join(output, "%04d.jpg"),
    ],
    300000,
  );

  const cues: string[] = [];
  for (let i = 0; i < frameCount; i++) {
    const sheet = Math.floor(i / FRAMES_PER_SHEET) + 1;
    const cell = i % FRAMES_PER_SHEET;
    const x = (cell % COLUMNS) * TILE_WIDTH;
    const y = Math.floor(cell / COLUMNS) * TILE_HEIGHT;
    const start = i * interval;
    const end = Math.min(duration, (i + 1) * interval);
    cues.push(
      `${stamp(start)} --> ${stamp(end)}\n${String(sheet).padStart(4, "0")}.jpg#xywh=${x},${y},${TILE_WIDTH},${TILE_HEIGHT}`,
    );
  }

  await writeFile(
    join(output, "previews.vtt"),
    `WEBVTT\n\n${cues.join("\n\n")}\n`,
  );

  return {
    interval,
    frameCount,
    sheetCount: Math.ceil(frameCount / FRAMES_PER_SHEET),
    tileWidth: TILE_WIDTH,
    tileHeight: TILE_HEIGHT,
  };
}
