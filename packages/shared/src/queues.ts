import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { config } from "../../config/src/index.js";
import { queueNames, type QueueName } from "./queue-names.js";
export { queueNames, type QueueName } from "./queue-names.js";
export const redis = new Redis(config.REDIS_URL, {
  maxRetriesPerRequest: null,
});
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
