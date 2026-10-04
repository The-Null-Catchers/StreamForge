export const queueNames = [
  "media-probe",
  "video-transcode",
  "thumbnail-generation",
  "poster-generation",
  "hls-packaging",
  "subtitle-processing",
  "webhooks",
  "analytics",
  "ai",
  "live-import",
  "cleanup",
] as const;

export type QueueName = (typeof queueNames)[number];
