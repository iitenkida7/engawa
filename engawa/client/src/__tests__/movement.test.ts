import { describe, expect, it } from 'bun:test';
import { PLAYER_RADIUS, STEP_DURATION_MS } from '@/core/types';
import { stepTarget } from '@/world/grid';
import { MovementController } from '@/world/movement';
import { PlayerState } from '@/world/player';
import { findWalkableSpawn, TILE_SIZE } from '@/world/tilemap';

const NONE = () => ({ dx: 0, dy: 0 });

// A walkable tile center on the real office map with a walkable neighbour in
// some cardinal direction, so the tests don't hard-code map coordinates.
function startWithOpenStep() {
  for (let row = 2; row < 20; row++) {
    for (let col = 2; col < 30; col++) {
      const x = col * TILE_SIZE + TILE_SIZE / 2;
      const y = row * TILE_SIZE + TILE_SIZE / 2;
      const spot = findWalkableSpawn(x, y, PLAYER_RADIUS);
      if (spot.x !== x || spot.y !== y) continue;
      for (const [dx, dy] of [
        [1, 0],
        [0, 1],
        [-1, 0],
        [0, -1],
      ]) {
        const next = stepTarget(x, y, dx, dy);
        if (next) return { start: { x, y }, dir: { dx, dy }, next };
      }
    }
  }
  throw new Error('no open step on the map');
}

function makeMe(x: number, y: number) {
  return new PlayerState({ userId: 'me', name: 'Me', x, y }, true);
}

describe('MovementController grid step', () => {
  it('slides exactly one tile over STEP_DURATION_MS and ignores input meanwhile', () => {
    const { start, dir, next } = startWithOpenStep();
    const me = makeMe(start.x, start.y);
    const m = new MovementController();
    const half = STEP_DURATION_MS / 2000;

    const v = m.update(me, half, () => dir);
    expect(v.vx !== 0 || v.vy !== 0).toBe(true);
    expect(me.x).toBeCloseTo((start.x + next.x) / 2);
    expect(me.y).toBeCloseTo((start.y + next.y) / 2);

    // Mid-step input is not read: the step finishes on the first tile.
    let read = 0;
    m.update(me, half, () => {
      read++;
      return dir;
    });
    expect(read).toBe(0);
    expect(me.x).toBeCloseTo(next.x);
    expect(me.y).toBeCloseTo(next.y);
    expect(me.targetX).toBe(me.x);

    // Idle with no input: stays put, zero velocity.
    expect(m.update(me, half, NONE)).toEqual({ vx: 0, vy: 0 });
    expect(me.x).toBeCloseTo(next.x);
  });

  it('turns to face a blocked direction without moving', () => {
    const me = makeMe(TILE_SIZE / 2, TILE_SIZE / 2);
    // Step off the top-left map edge: never walkable.
    const v = new MovementController().update(me, 0.016, () => ({ dx: -1, dy: 0 }));
    expect(v).toEqual({ vx: 0, vy: 0 });
    expect(me.x).toBe(TILE_SIZE / 2);
    expect(me.facing).toBe('left');
  });
});

describe('MovementController click-to-move', () => {
  it('walks a route to its destination, then clears it', () => {
    const { start, next } = startWithOpenStep();
    const me = makeMe(start.x, start.y);
    const m = new MovementController();
    expect(m.destination).toBeNull();

    expect(m.walkTo(me, next)).toBe(true);
    expect(m.destination).toEqual(next);
    for (let i = 0; i < 200 && m.destination; i++) m.update(me, 0.016, NONE);
    expect(m.destination).toBeNull();
    expect(Math.hypot(me.x - next.x, me.y - next.y)).toBeLessThanOrEqual(4);
  });

  it('keyboard input cancels the route', () => {
    const { start, dir, next } = startWithOpenStep();
    const me = makeMe(start.x, start.y);
    const m = new MovementController();
    m.walkTo(me, next);
    m.update(me, 0.016, () => dir);
    expect(m.destination).toBeNull();
  });

  it('walkTo with no path returns false and clears the route', () => {
    const { start, next } = startWithOpenStep();
    const me = makeMe(start.x, start.y);
    const m = new MovementController();
    m.walkTo(me, next);
    // The current tile is the goal: findPath returns an empty route.
    expect(m.walkTo(me, start)).toBe(false);
    expect(m.destination).toBeNull();
  });
});
