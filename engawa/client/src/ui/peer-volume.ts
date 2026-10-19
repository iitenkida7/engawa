// Per-person playback volume (pure helpers; the wiring lives in ui/remote-media.ts).
//
// The gain is a multiplier on the remote voice: 1 = as received, below 1 quieter,
// above 1 louder. It lasts exactly as long as the conversation that prompted it
// (the view keeps it on the tile): what you are correcting is how someone sounds
// right now — their mic, their room, how close they are sitting — and that is
// stale by the next time you walk up to them.

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

// How far either side of 100% still counts as 100%. The default is the one
// value worth hitting exactly — "put this person back how everyone else sounds"
// — and a magnet lands it every time, where a 1px-accurate drag does not.
export const PEER_SNAP_PCT = 5;

// Slider position → the percent to actually use: anything inside the magnet
// snaps to 100. Pointer drags only; arrow keys skip it, or the slider would be
// stuck at 100 for every step inside the band.
export function snapPercent(p: number): number {
  const v = Math.round(p);
  return Math.abs(v - 100) <= PEER_SNAP_PCT ? 100 : v;
}
