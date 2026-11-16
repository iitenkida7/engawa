// Keyboard dash: hold a direction long enough and the avatar breaks into a run
// that survives turning corners. Pure state machine (no DOM, no clock of its
// own) so the timing rules can be unit-tested; MovementController feeds it once
// per frame.

import { STEP_DURATION_MS } from '@/core/types';

// How long a direction must be held before the dash switches on.
export const DASH_HOLD_MS = 500;
// How long all keys may be up before the dash ends. Turning a corner means
// letting go of one key and pressing another, which always leaves a short gap.
export const DASH_GRACE_MS = 100;
// A dash step takes this long (a walking step takes STEP_DURATION_MS = 238).
export const DASH_STEP_DURATION_MS = 120;

export interface DashState {
  // How long a direction has been held, in ms (kept through a short gap).
  heldMs: number;
  // How long no direction has been held, in ms.
  releasedMs: number;
  dashing: boolean;
}

export const INITIAL_DASH: DashState = { heldMs: 0, releasedMs: 0, dashing: false };

/**
 * The next dash state after one frame of `dtMs` milliseconds.
 * - held: a direction key is down this frame.
 * - blocked: we tried to step and a wall was in the way (ends the dash).
 */
export function nextDashState(
  state: DashState,
  held: boolean,
  blocked: boolean,
  dtMs: number,
): DashState {
  if (blocked) return INITIAL_DASH;
  if (held) {
    const heldMs = state.heldMs + dtMs;
    return { heldMs, releasedMs: 0, dashing: state.dashing || heldMs >= DASH_HOLD_MS };
  }
  // Nothing was ever held (or the dash already ended): stay at rest.
  if (state.heldMs === 0) return INITIAL_DASH;
  const releasedMs = state.releasedMs + dtMs;
  if (releasedMs > DASH_GRACE_MS) return INITIAL_DASH;
  return { ...state, releasedMs };
}

/** How long one tile step takes in the given state. */
export function stepDurationMs(state: DashState): number {
  return state.dashing ? DASH_STEP_DURATION_MS : STEP_DURATION_MS;
}
