import { describe, expect, it } from 'bun:test';
import {
  DUST_ALPHA,
  DUST_END_RADIUS,
  DUST_LIFE_MS,
  DUST_SPACING,
  DUST_START_RADIUS,
  isRunning,
  puffLook,
  puffsToSpawn,
  RUN_SPEED,
} from '@/world/dust';
import { PlayerState } from '@/world/player';

describe('isRunning', () => {
  it('counts a keyboard dash and a click-move, but not a walk', () => {
    expect(isRunning(210)).toBe(false); // PLAYER_SPEED
    expect(isRunning(420)).toBe(true); // keyboard dash
    expect(isRunning(630)).toBe(true); // click-move
    expect(isRunning(RUN_SPEED)).toBe(false); // the threshold itself is not "over"
  });
});

describe('puffsToSpawn', () => {
  it('kicks up nothing while not running, and clears the carry', () => {
    expect(puffsToSpawn(10, 50, false)).toEqual({ count: 0, carry: 0 });
  });

  it('adds one puff per DUST_SPACING travelled', () => {
    expect(puffsToSpawn(0, DUST_SPACING, true)).toEqual({ count: 1, carry: 0 });
    expect(puffsToSpawn(0, DUST_SPACING * 2.5, true).count).toBe(2);
  });

  it('carries leftover distance across frames', () => {
    const first = puffsToSpawn(0, DUST_SPACING - 6, true);
    expect(first.count).toBe(0);
    const second = puffsToSpawn(first.carry, 10, true);
    expect(second.count).toBe(1);
    expect(second.carry).toBeCloseTo(4);
  });
});

describe('puffLook', () => {
  it('starts small and strong, then grows and fades', () => {
    const born = puffLook(0);
    const old = puffLook(DUST_LIFE_MS - 1);
    expect(born).toEqual({ radius: DUST_START_RADIUS, alpha: DUST_ALPHA });
    expect(old?.radius).toBeGreaterThan(born?.radius ?? 0);
    expect(old?.radius).toBeLessThanOrEqual(DUST_END_RADIUS);
    expect(old?.alpha).toBeLessThan(born?.alpha ?? 0);
  });

  it('is gone once its life is over (or if the age is negative)', () => {
    expect(puffLook(DUST_LIFE_MS)).toBeNull();
    expect(puffLook(DUST_LIFE_MS + 100)).toBeNull();
    expect(puffLook(-1)).toBeNull();
  });
});

describe('PlayerState speed (drives the dust)', () => {
  it('reads a fast mover as running and a walker as not', () => {
    const run = new PlayerState({ userId: 'r', name: 'R', x: 0, y: 0 }, true);
    const walk = new PlayerState({ userId: 'w', name: 'W', x: 0, y: 0 }, true);
    run.advanceWalk(0);
    walk.advanceWalk(0);
    for (let i = 1; i <= 30; i++) {
      run.x += 7; // 7px per 16ms frame ≈ 437 px/s (a dash)
      walk.x += 3.4; // ≈ 212 px/s (a walk)
      run.advanceWalk(i * 16);
      walk.advanceWalk(i * 16);
    }
    expect(isRunning(run.speed)).toBe(true);
    expect(isRunning(walk.speed)).toBe(false);
    expect(run.stepDist).toBeCloseTo(7);
  });
});
