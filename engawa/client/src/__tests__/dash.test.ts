import { describe, expect, it } from 'bun:test';
import { STEP_DURATION_MS } from '@/core/types';
import {
  DASH_GRACE_MS,
  DASH_HOLD_MS,
  DASH_STEP_DURATION_MS,
  type DashState,
  INITIAL_DASH,
  nextDashState,
  stepDurationMs,
} from '@/world/dash';

// Feed the same input for `totalMs`, in 16ms frames.
function run(state: DashState, held: boolean, totalMs: number, blocked = false): DashState {
  let s = state;
  for (let t = 0; t < totalMs; t += 16) s = nextDashState(s, held, blocked, 16);
  return s;
}

describe('nextDashState', () => {
  it('does not dash on a short press', () => {
    expect(run(INITIAL_DASH, true, DASH_HOLD_MS - 50).dashing).toBe(false);
  });

  it('starts dashing once a direction is held long enough', () => {
    expect(run(INITIAL_DASH, true, DASH_HOLD_MS + 50).dashing).toBe(true);
  });

  it('keeps dashing through the short gap of a turn', () => {
    const dashing = run(INITIAL_DASH, true, DASH_HOLD_MS + 50);
    const gap = run(dashing, false, DASH_GRACE_MS - 20);
    expect(gap.dashing).toBe(true);
    // The next key goes down: still dashing, and the gap counter is cleared.
    const turned = nextDashState(gap, true, false, 16);
    expect(turned.dashing).toBe(true);
    expect(turned.releasedMs).toBe(0);
  });

  it('ends the dash when the keys stay up past the grace time', () => {
    const dashing = run(INITIAL_DASH, true, DASH_HOLD_MS + 50);
    expect(run(dashing, false, DASH_GRACE_MS + 50)).toEqual(INITIAL_DASH);
  });

  it('does not let a quick re-press after a long gap count as a dash', () => {
    const early = run(INITIAL_DASH, true, DASH_HOLD_MS - 100);
    const after = run(early, false, DASH_GRACE_MS + 50);
    expect(run(after, true, 200).dashing).toBe(false);
  });

  it('ends the dash when a wall blocks the step', () => {
    const dashing = run(INITIAL_DASH, true, DASH_HOLD_MS + 50);
    expect(nextDashState(dashing, true, true, 16)).toEqual(INITIAL_DASH);
  });

  it('stays idle when nothing is held', () => {
    expect(run(INITIAL_DASH, false, 1000)).toEqual(INITIAL_DASH);
  });
});

describe('stepDurationMs', () => {
  it('is the walking time normally and shorter while dashing', () => {
    expect(stepDurationMs(INITIAL_DASH)).toBe(STEP_DURATION_MS);
    expect(stepDurationMs({ ...INITIAL_DASH, dashing: true })).toBe(DASH_STEP_DURATION_MS);
    expect(DASH_STEP_DURATION_MS).toBeLessThan(STEP_DURATION_MS);
  });
});
