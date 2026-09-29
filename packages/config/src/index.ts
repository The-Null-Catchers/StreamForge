import { z } from "zod";
const schema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  PORT: z.coerce.number().default(4000),
  PUBLIC_URL: z.url().default("http://localhost:8080"),
  WEB_ORIGIN: z.url().default("http://localhost:8080"),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  JWT_SECRET: z.string().min(32),
  PLAYBACK_SECRET: z.string().min(32),
  S3_ENDPOINT: z.url(),
  S3_REGION: z.string().default("us-east-1"),
  S3_BUCKET: z.string().default("streamforge"),
  S3_ACCESS_KEY: z.string(),
  S3_SECRET_KEY: z.string(),
  S3_FORCE_PATH_STYLE: z.string().default("true"),
  TRANSCODE_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(2),
  MAX_UPLOAD_SIZE_GB: z.coerce.number().positive().default(20),
  MAX_VIDEO_DURATION_HOURS: z.coerce.number().positive().default(6),
  UPLOAD_TTL_HOURS: z.coerce.number().positive().default(48),
  PLAYBACK_TTL_SECONDS: z.coerce
    .number()
    .int()
    .min(60)
    .max(21600)
    .default(3600),
  SMTP_HOST: z.string().default("mailpit"),
  SMTP_PORT: z.coerce.number().default(1025),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  MAIL_FROM: z.string().default("StreamForge <no-reply@localhost>"),
  WEBHOOK_ALLOWED_HOSTS: z.string().default(""),
  TRANSCRIPTION_PROVIDER: z
    .enum(["disabled", "openai-compatible"])
    .default("disabled"),
  TRANSCRIPTION_BASE_URL: z.url().default("https://api.openai.com/v1"),
  TRANSCRIPTION_API_KEY: z.string().optional(),
  TRANSCRIPTION_MODEL: z.string().default("whisper-1"),
  TRANSCRIPTION_CHUNK_SECONDS: z.coerce
    .number()
    .int()
    .min(60)
    .max(1800)
    .default(600),
});
export const config = schema.parse(process.env);
if (
  config.NODE_ENV === "production" &&
  [config.JWT_SECRET, config.PLAYBACK_SECRET].some((s) =>
    s.includes("replace-with"),
  )
)
  throw Error("Configure production secrets");

if (
  config.TRANSCRIPTION_PROVIDER !== "disabled" &&
  !config.TRANSCRIPTION_API_KEY
)
  throw Error("Configure TRANSCRIPTION_API_KEY");
