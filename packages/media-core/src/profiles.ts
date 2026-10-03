import type { Rendition } from "./index.js";

export const transcodingProfiles = ["data_saver", "balanced", "quality"] as const;
export type TranscodingProfile = (typeof transcodingProfiles)[number];

export const transcodingProfileInfo: Record<
  TranscodingProfile,
  { label: string; description: string; bitrateMultiplier: number; maxHeight: number }
> = {
  data_saver: {
    label: "Data saver",
    description: "Lower bitrate ladder capped at 1080p for bandwidth-sensitive delivery.",
    bitrateMultiplier: 0.65,
    maxHeight: 1080,
  },
  balanced: {
    label: "Balanced",
    description: "Default source-aware ladder for general playback.",
    bitrateMultiplier: 1,
    maxHeight: 2160,
  },
  quality: {
    label: "High quality",
    description: "Higher bitrate ladder for visual quality when storage and bandwidth allow.",
    bitrateMultiplier: 1.3,
    maxHeight: 2160,
  },
};

const baseLadder = [
  { height: 360, bitrate: 800000 },
  { height: 480, bitrate: 1400000 },
  { height: 720, bitrate: 2800000 },
  { height: 1080, bitrate: 5000000 },
  { height: 2160, bitrate: 14000000 },
];

export function profileRenditions(
  width: number,
  height: number,
  profile: TranscodingProfile = "balanced",
): Rendition[] {
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width < 2 ||
    height < 2
  )
    throw Error("INVALID_DIMENSIONS");

  const preset = transcodingProfileInfo[profile];
  const ceiling = Math.min(height, preset.maxHeight);
  const selected = baseLadder
    .filter((item) => item.height <= ceiling)
    .map((item) => ({
      ...item,
      bitrate: Math.max(250000, Math.round(item.bitrate * preset.bitrateMultiplier)),
    }));

  if (!selected.length) {
    selected.push({
      height: Math.max(2, Math.floor(height / 2) * 2),
      bitrate: Math.max(250000, Math.round(500000 * preset.bitrateMultiplier)),
    });
  }

  return selected.map((item) => ({
    ...item,
    width: Math.max(2, Math.floor((width * item.height) / height / 2) * 2),
    name: `${item.height}p`,
  }));
}
