export function crossedThresholds(used: number, limit: number) {
  if (!Number.isFinite(used) || !Number.isFinite(limit) || used < 0 || limit < 0)
    return [] as number[];
  if (limit === 0) return used > 0 ? [80, 90, 100] : [];
  const pct = (used / limit) * 100;
  return [80, 90, 100].filter((threshold) => pct >= threshold);
}
