// Dust puffs kicked up by a running avatar, so a rush reads as a rush. Pure
// helpers (no canvas, no clock): the renderer owns the puffs and the drawing,
// this file owns the numbers, which keeps them unit-testable.

// On-screen speed (px/s) above which an avatar counts as running. Walking is 210,
// a keyboard dash about 420 and a click-move 630, so this sits between them.
export const RUN_SPEED = 300;
// A puff is kicked up every this many px travelled while running (distance, not
// time, so the trail looks the same at any frame rate).
export const DUST_SPACING = 26;
// A puff lives this long.
export const DUST_LIFE_MS = 450;
// A puff grows from DUST_START_RADIUS to DUST_END_RADIUS (map px) as it fades.
export const DUST_START_RADIUS = 4;
export const DUST_END_RADIUS = 13;
// Peak opacity of a fresh puff.
export const DUST_ALPHA = 0.4;
// Hard cap on puffs alive at once, so a crowd of runners can't pile up.
export const DUST_MAX_PUFFS = 120;

/** Whether an on-screen speed (px/s) counts as running. */
export function isRunning(speed: number): boolean {
  return speed > RUN_SPEED;
}

/**
 * How many puffs to kick up after travelling `dist` px, and the leftover distance
 * to carry into the next frame. Not running resets the carry, so a new run starts
 * with a clean first puff spacing.
 */
export function puffsToSpawn(
  carry: number,
  dist: number,
  running: boolean,
): { count: number; carry: number } {
  if (!running) return { count: 0, carry: 0 };
  const total = carry + dist;
  return { count: Math.floor(total / DUST_SPACING), carry: total % DUST_SPACING };
}

/** Radius and opacity of a puff `ageMs` old, or null once it has faded away. */
export function puffLook(ageMs: number): { radius: number; alpha: number } | null {
  if (ageMs < 0 || ageMs >= DUST_LIFE_MS) return null;
  const t = ageMs / DUST_LIFE_MS;
  return {
    radius: DUST_START_RADIUS + (DUST_END_RADIUS - DUST_START_RADIUS) * t,
    alpha: DUST_ALPHA * (1 - t),
  };
}
