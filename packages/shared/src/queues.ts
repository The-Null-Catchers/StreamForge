import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { config } from "../../config/src/index.js";
export const redis = new Redis(config.REDIS_URL, {
  maxRetriesPerRequest: null,
});
export const queueNames = [
  "media-probe",
  "video-transcode",
  "thumbnail-generation",
  "hls-packaging",
  "subtitle-processing",
  "webhooks",
  "analytics",
  "ai",
  "cleanup",
] as const;
export type QueueName = (typeof queueNames)[number];
export const queues = Object.fromEntries(
  queueNames.map((name) => [
    name,
    new Queue(name, {
      connection: redis,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: "exponential", delay: 5000 },
        removeOnComplete: { age: 86400, count: 10000 },
        removeOnFail: { age: 604800 },
      },
    }),
  ]),
) as Record<QueueName, Queue>;
