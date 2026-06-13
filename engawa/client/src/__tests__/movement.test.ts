import { describe, expect, it } from 'bun:test';
import { MovementController } from '@/core/movement';
import { type ClientMessage, PLAYER_RADIUS, PLAYER_SPEED } from '@/core/types';
import { PlayerState } from '@/world/player';
import { findWalkableSpawn } from '@/world/tilemap';

// A guaranteed-walkable starting point in the open office area.
const START = findWalkableSpawn(1000, 750, PLAYER_RADIUS);

function make() {
  const sent: ClientMessage[] = [];
  const movement = new MovementController({ send: (m) => sent.push(m) });
  const me = new PlayerState({ userId: 'u1', name: 'n', x: START.x, y: START.y }, true);
  return { sent, movement, me };
}

describe('MovementController.update', () => {
  it('moves self by velocity × dt on keyboard input and faces that way', () => {
    const { movement, me } = make();
    const x0 = me.x;
    const v = movement.update(me, { dx: 1, dy: 0 }, 0.1);
    expect(v).toEqual({ vx: PLAYER_SPEED, vy: 0 });
    expect(me.x).toBeCloseTo(x0 + PLAYER_SPEED * 0.1, 3);
    expect(me.facing).toBe('right');
  });

  it('keyboard input cancels an active click-to-move route', () => {
    const { movement, me } = make();
    expect(movement.setDestination(me, me.x + 120, me.y)).toBe(true);
    expect(movement.destination).not.toBeNull();
    movement.update(me, { dx: 0, dy: 1 }, 0.016);
    expect(movement.destination).toBeNull();
  });

  it('follows a click-to-move route to the goal and then stops', () => {
    const { movement, me } = make();
    const ok = movement.setDestination(me, me.x + 120, me.y);
    expect(ok).toBe(true);
    const goal = movement.destination;
    if (!goal) throw new Error('expected a destination');
    let v = { vx: 0, vy: 0 };
    for (let i = 0; i < 600 && movement.destination; i++) {
      v = movement.update(me, { dx: 0, dy: 0 }, 0.016);
    }
    expect(movement.destination).toBeNull();
    // Arrival reports zero velocity (the stop signal the broadcast relies on).
    expect(v).toEqual({ vx: 0, vy: 0 });
    expect(Math.hypot(me.x - goal.x, me.y - goal.y)).toBeLessThan(20);
  });
});

describe('MovementController.maybeSendPosition', () => {
  it('sends immediately when the velocity changes (start and stop)', () => {
    const { sent, movement, me } = make();
    movement.maybeSendPosition(me, PLAYER_SPEED, 0, 1000);
    expect(sent.length).toBe(1);
    const first = sent[0];
    if (first.type !== 'move') throw new Error('expected a move message');
    expect(first.vx).toBe(PLAYER_SPEED);
    // Velocity transition to 0 → an immediate stop signal, ignoring the cadence.
    movement.maybeSendPosition(me, 0, 0, 1001);
    expect(sent.length).toBe(2);
  });

  it('throttles steady movement to the send cadence', () => {
    const { sent, movement, me } = make();
    movement.maybeSendPosition(me, PLAYER_SPEED, 0, 1000);
    // Same velocity, no time elapsed → no resend even though we moved.
    me.x += 10;
    movement.maybeSendPosition(me, PLAYER_SPEED, 0, 1001);
    expect(sent.length).toBe(1);
    // Past the cadence with a real position delta → resend.
    movement.maybeSendPosition(me, PLAYER_SPEED, 0, 1200);
    expect(sent.length).toBe(2);
  });

  it('stays silent while idle (no velocity change, no movement)', () => {
    const { sent, movement, me } = make();
    movement.maybeSendPosition(me, 0, 0, 1000);
    const baseline = sent.length;
    movement.maybeSendPosition(me, 0, 0, 2000);
    movement.maybeSendPosition(me, 0, 0, 3000);
    expect(sent.length).toBe(baseline);
  });
});
