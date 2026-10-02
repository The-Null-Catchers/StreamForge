import { readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function cleanupStaleTempDirs(
  root = tmpdir(),
  olderThanMs = 6 * 60 * 60 * 1000,
  now = Date.now(),
) {
  let removed = 0;
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return removed;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith("streamforge-")) continue;
    const path = join(root, entry.name);
    try {
      const info = await stat(path);
      if (now - info.mtimeMs < olderThanMs) continue;
      await rm(path, { recursive: true, force: true });
      removed++;
    } catch {
      // Ignore races and filesystem cleanup failures; the next maintenance pass retries.
    }
  }
  return removed;
}
