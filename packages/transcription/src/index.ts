import { basename } from "node:path";
import { readFile } from "node:fs/promises";
import { config } from "../../config/src/index.js";

export type TranscriptionSegment = {
  start: number;
  end: number;
  text: string;
};

export type TranscriptionResult = {
  language?: string;
  segments: TranscriptionSegment[];
};

export interface TranscriptionProvider {
  transcribe(file: string, language?: "ar" | "en"): Promise<TranscriptionResult>;
}

class OpenAICompatibleTranscriptionProvider implements TranscriptionProvider {
  async transcribe(
    file: string,
    language?: "ar" | "en",
  ): Promise<TranscriptionResult> {
    const body = new FormData();
    const bytes = await readFile(file);
    body.set("file", new Blob([bytes], { type: "audio/mpeg" }), basename(file));
    body.set("model", config.TRANSCRIPTION_MODEL);
    body.set("response_format", "verbose_json");
    body.append("timestamp_granularities[]", "segment");
    if (language) body.set("language", language);

    const response = await fetch(
      `${config.TRANSCRIPTION_BASE_URL.replace(/\/$/, "")}/audio/transcriptions`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.TRANSCRIPTION_API_KEY}`,
        },
        body,
        signal: AbortSignal.timeout(180000),
      },
    );
    if (!response.ok)
      throw Error(`TRANSCRIPTION_PROVIDER_${response.status}`);

    const json = (await response.json()) as {
      language?: string;
      segments?: Array<{ start?: number; end?: number; text?: string }>;
      text?: string;
    };
    const segments = (json.segments ?? [])
      .map((segment) => ({
        start: Number(segment.start),
        end: Number(segment.end),
        text: String(segment.text ?? "").trim(),
      }))
      .filter(
        (segment) =>
          Number.isFinite(segment.start) &&
          Number.isFinite(segment.end) &&
          segment.end >= segment.start &&
          segment.text.length > 0,
      );
    if (!segments.length && json.text?.trim())
      return {
        language: json.language,
        segments: [{ start: 0, end: 0, text: json.text.trim() }],
      };
    if (!segments.length) throw Error("TRANSCRIPTION_EMPTY");
    return { language: json.language, segments };
  }
}

export function transcriptionProvider(): TranscriptionProvider {
  if (config.TRANSCRIPTION_PROVIDER === "openai-compatible")
    return new OpenAICompatibleTranscriptionProvider();
  throw Error("TRANSCRIPTION_NOT_CONFIGURED");
}

function timestamp(seconds: number) {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const hours = Math.floor(ms / 3600000);
  const minutes = Math.floor((ms % 3600000) / 60000);
  const secs = Math.floor((ms % 60000) / 1000);
  const millis = ms % 1000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
}

export function transcriptionVtt(segments: TranscriptionSegment[]) {
  if (!segments.length) throw Error("TRANSCRIPTION_EMPTY");
  return (
    "WEBVTT\n\n" +
    segments
      .map(
        (segment, index) =>
          `${index + 1}\n${timestamp(segment.start)} --> ${timestamp(
            Math.max(segment.end, segment.start + 0.001),
          )}\n${segment.text.replace(/\s+/g, " ").trim()}\n`,
      )
      .join("\n")
  );
}
