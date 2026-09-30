import { z } from "zod";

export type AiKind = "summary" | "metadata" | "chapters" | "all";
export type AiLanguage = "auto" | "ar" | "en";

export type AiProviderOptions = {
  baseUrl: string;
  apiKey: string;
  model: string;
};

export type AiMediaResult = {
  summary?: string;
  title?: string;
  description?: string;
  tags?: string[];
  chapters?: Array<{ startSeconds: number; title: string }>;
};

const resultSchema = z.object({
  summary: z.string().min(1).max(5000).optional(),
  title: z.string().min(1).max(160).optional(),
  description: z.string().min(1).max(3000).optional(),
  tags: z.array(z.string().min(1).max(60)).max(20).optional(),
  chapters: z
    .array(
      z.object({
        startSeconds: z.number().min(0).max(86400),
        title: z.string().min(1).max(120),
      }),
    )
    .max(100)
    .optional(),
});

function languageInstruction(language: AiLanguage) {
  if (language === "ar") return "Write all generated text in Arabic.";
  if (language === "en") return "Write all generated text in English.";
  return "Use the primary language of the transcript.";
}

function outputInstruction(kind: AiKind) {
  if (kind === "summary")
    return 'Return JSON with only: {"summary":"..."}.';
  if (kind === "metadata")
    return 'Return JSON with: {"title":"...","description":"...","tags":["..."]}.';
  if (kind === "chapters")
    return 'Return JSON with only: {"chapters":[{"startSeconds":0,"title":"..."}]}.';
  return 'Return JSON with: {"summary":"...","title":"...","description":"...","tags":["..."],"chapters":[{"startSeconds":0,"title":"..."}]}.';
}

export async function generateMediaHelpers(
  options: AiProviderOptions,
  input: {
    kind: AiKind;
    language: AiLanguage;
    transcript: string;
    duration: number;
    currentTitle?: string;
  },
): Promise<AiMediaResult> {
  const response = await fetch(
    `${options.baseUrl.replace(/\/$/, "")}/chat/completions`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: options.model,
        temperature: 0.2,
        messages: [
          {
            role: "system",
            content:
              "You are a media metadata assistant. Use only facts present in the transcript. Never invent people, claims, links, dates, or topics. Chapter timestamps must be within the provided duration and ordered. Return valid JSON only.",
          },
          {
            role: "user",
            content: [
              languageInstruction(input.language),
              outputInstruction(input.kind),
              `Video duration: ${input.duration} seconds.`,
              input.currentTitle
                ? `Current title: ${input.currentTitle}`
                : "",
              "Transcript:",
              input.transcript,
            ]
              .filter(Boolean)
              .join("\n\n"),
          },
        ],
      }),
      signal: AbortSignal.timeout(120000),
    },
  );
  if (!response.ok) throw Error(`AI_PROVIDER_${response.status}`);
  const json = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  let text = json.choices?.[0]?.message?.content?.trim() ?? "";
  text = text.replace(/^\`\`\`(?:json)?\s*/i, "").replace(/\s*\`\`\`$/, "");
  if (!text) throw Error("AI_EMPTY_RESPONSE");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw Error("AI_INVALID_JSON");
  }
  const result = resultSchema.parse(parsed);
  if (result.chapters) {
    result.chapters = result.chapters
      .filter((chapter) => chapter.startSeconds <= input.duration)
      .sort((a, b) => a.startSeconds - b.startSeconds)
      .filter(
        (chapter, index, all) =>
          index === 0 || chapter.startSeconds > all[index - 1]!.startSeconds,
      );
  }
  return result;
}
