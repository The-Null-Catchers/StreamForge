import { queueNames, type QueueName } from "../../../packages/shared/src/queue-names.js";

export function workerQueueSelection(value: string) {
  const requested = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  if (!requested.length) return [...queueNames] as QueueName[];

  const invalid = requested.filter(
    (name) => !queueNames.includes(name as QueueName),
  );
  if (invalid.length)
    throw new Error(`Unknown worker queue(s): ${invalid.join(", ")}`);

  return Array.from(new Set(requested)) as QueueName[];
}
