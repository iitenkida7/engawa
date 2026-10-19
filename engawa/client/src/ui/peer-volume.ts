// Per-person playback volume (pure helpers; the wiring lives in ui/remote-media.ts).
//
// The gain is a multiplier on the remote voice: 1 = as received, below 1 quieter,
// above 1 louder. It is remembered per display name (user ids are minted fresh on
// every connection, so they can't identify the same person across a reload).

export const PEER_VOLUME_STORAGE_KEY = 'engawa-peer-volume';

export const PEER_GAIN_MIN = 0;
export const PEER_GAIN_MAX = 2;
export const PEER_GAIN_DEFAULT = 1;

// Clamp to the supported range; anything that is not a finite number is the default.
export function clampGain(g: unknown): number {
  if (typeof g !== 'number' || !Number.isFinite(g)) return PEER_GAIN_DEFAULT;
  return Math.min(PEER_GAIN_MAX, Math.max(PEER_GAIN_MIN, g));
}

// Slider position (percent, 0–200) ⇄ gain. Rounded so 0.1+0.2 style float noise
// never shows up as 30.000000000000004%.
export function gainToPercent(g: number): number {
  return Math.round(clampGain(g) * 100);
}
export function percentToGain(p: number): number {
  return clampGain(p / 100);
}

// Parse the stored name → gain map. Corrupt JSON, wrong shapes and out-of-range
// values are dropped rather than trusted; default-valued entries are omitted.
export function parseVolumeMap(stored: string | null): Record<string, number> {
  if (!stored) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(stored);
  } catch {
    return {};
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, number> = {};
  for (const [name, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    const g = clampGain(v);
    if (g !== PEER_GAIN_DEFAULT) out[name] = g;
  }
  return out;
}
