import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { run, type Metadata } from "./index.js";

export type AudioTrack = {
  ordinal: number;
  name: string;
  language?: string;
  isDefault: boolean;
};

function cleanAttribute(value: unknown) {
  return String(value ?? "")
    .replace(/[\r\n"]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function audioTracksFromMetadata(metadata: Metadata): AudioTrack[] {
  const raw = metadata.raw as {
    streams?: Array<{
      codec_type?: string;
      tags?: { language?: string; title?: string };
      disposition?: { default?: number };
    }>;
  };
  const streams = (raw.streams ?? []).filter(
    (stream) => stream.codec_type === "audio",
  );
  const explicitDefault = streams.findIndex(
    (stream) => Number(stream.disposition?.default) === 1,
  );

  return streams.map((stream, ordinal) => {
    const language = cleanAttribute(stream.tags?.language);
    const title = cleanAttribute(stream.tags?.title);
    return {
      ordinal,
      name: title || language || `Audio ${ordinal + 1}`,
      language: /^[A-Za-z0-9-]{2,15}$/.test(language) ? language : undefined,
      isDefault:
        explicitDefault >= 0 ? ordinal === explicitDefault : ordinal === 0,
    };
  });
}

export async function transcodeAudioTracks(
  source: string,
  output: string,
  metadata: Metadata,
) {
  const tracks = audioTracksFromMetadata(metadata);
  for (const track of tracks) {
    const dir = join(output, "audio", `track-${track.ordinal + 1}`);
    await mkdir(dir, { recursive: true });
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
        `0:a:${track.ordinal}`,
        "-vn",
        "-c:a",
        "aac",
        "-b:a",
        "128k",
        "-ac",
        "2",
        "-f",
        "hls",
        "-hls_time",
        "4",
        "-hls_playlist_type",
        "vod",
        "-hls_flags",
        "independent_segments",
        "-hls_segment_filename",
        join(dir, "segment-%05d.ts"),
        join(dir, "index.m3u8"),
      ],
      7200000,
    );
  }
  return tracks;
}

export function audioMediaLines(tracks: AudioTrack[]) {
  return tracks.map((track) => {
    const attributes = [
      "TYPE=AUDIO",
      'GROUP-ID="audio"',
      `NAME="${track.name}"`,
      `DEFAULT=${track.isDefault ? "YES" : "NO"}`,
      "AUTOSELECT=YES",
      `URI="audio/track-${track.ordinal + 1}/index.m3u8"`,
    ];
    if (track.language) attributes.splice(3, 0, `LANGUAGE="${track.language}"`);
    return `#EXT-X-MEDIA:${attributes.join(",")}`;
  });
}
