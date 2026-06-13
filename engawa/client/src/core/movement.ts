// Self-movement, extracted from App so the physics (wall sliding, click-to-move
// path following) and the position-broadcast throttle are testable on their
// own. The App feeds it one frame at a time from the game loop; this class owns
// the click-to-move route and the last-sent position/velocity.

import type { Point } from '@/core/proximity';
import {
  CLICK_MOVE_ARRIVE_THRESHOLD,
  CLICK_MOVE_MULTIPLIER,
  type ClientMessage,
  COLLISION_RADIUS,
  MAP_HEIGHT,
  MAP_WIDTH,
  PLAYER_RADIUS,
  PLAYER_SPEED,
  POSITION_SEND_INTERVAL_MS,
} from '@/core/types';
import { findPath } from '@/world/pathfind';
import type { PlayerState } from '@/world/player';
import { canOccupy, findWalkableSpawn, zoneAt } from '@/world/tilemap';

export class MovementController {
  private send: (msg: ClientMessage) => void;

  private lastSent = 0;
  private lastSentX = 0;
  private lastSentY = 0;
  private lastSentVx = 0;
  private lastSentVy = 0;

  // Click-to-move: remaining waypoint tile-centers and the current index.
  private movePath: Point[] | null = null;
  private moveIndex = 0;

  constructor(opts: { send: (msg: ClientMessage) => void }) {
    this.send = opts.send;
  }

  // Route self to (x, y): snap a click on a wall/desk to the nearest walkable
  // tile, then A* around walls (boosted speed in followPath). Returns whether a
  // route exists — the route is cleared when it doesn't.
  setDestination(me: PlayerState, x: number, y: number): boolean {
    const goal = findWalkableSpawn(x, y, PLAYER_RADIUS);
    const path = findPath({ x: me.x, y: me.y }, goal);
    if (path.length === 0) {
      this.movePath = null;
      return false;
    }
    this.movePath = path;
    this.moveIndex = 0;
    return true;
  }

  // The route's final waypoint (the renderer's destination marker), or null
  // when there is no active click-to-move route.
  get destination(): Point | null {
    return this.movePath ? this.movePath[this.movePath.length - 1] : null;
  }

  // One frame of self-movement (frame-rate independent: dt × speed-per-second).
  // Keyboard input wins over click-to-move; returns the velocity applied this
  // frame so the caller can broadcast it. Also turns the avatar's sprite to
  // face the way we're moving (remote players turn via setTarget); idle keeps
  // the last facing.
  update(me: PlayerState, dir: { dx: number; dy: number }, dt: number): { vx: number; vy: number } {
    let vx = 0;
    let vy = 0;
    if (dir.dx !== 0 || dir.dy !== 0) {
      // Manual keyboard input cancels click-to-move and takes over.
      this.movePath = null;
      vx = dir.dx * PLAYER_SPEED;
      vy = dir.dy * PLAYER_SPEED;
      this.applyVelocity(me, vx, vy, dt);
    } else if (this.movePath) {
      const v = this.followPath(me, dt);
      vx = v.vx;
      vy = v.vy;
    }
    me.updateFacing(vx, vy);
    return { vx, vy };
  }

  // Periodic position broadcast. Also send when velocity changes (especially
  // when it transitions to 0) so the receiver stops extrapolating.
  maybeSendPosition(me: PlayerState, vx: number, vy: number, now: number) {
    const velChanged = vx !== this.lastSentVx || vy !== this.lastSentVy;
    const posMoved = Math.abs(me.x - this.lastSentX) > 0.5 || Math.abs(me.y - this.lastSentY) > 0.5;
    const intervalElapsed = now - this.lastSent > POSITION_SEND_INTERVAL_MS;
    // Send immediately on velocity change (e.g. key released → stop signal);
    // otherwise send at the regular cadence while moving.
    if (velChanged || (intervalElapsed && posMoved)) {
      this.send({
        type: 'move',
        x: me.x,
        y: me.y,
        vx,
        vy,
        // Report our meeting-room zone so the server can group us (SFU vs mesh).
        zoneId: zoneAt(me.x, me.y)?.id ?? null,
      });
      this.lastSentX = me.x;
      this.lastSentY = me.y;
      this.lastSentVx = vx;
      this.lastSentVy = vy;
      this.lastSent = now;
    }
  }

  // Moves self by a velocity for one frame, sliding along walls (per-axis
  // canOccupy). Returns whether the position actually changed.
  private applyVelocity(me: PlayerState, vx: number, vy: number, dt: number): boolean {
    if (vx === 0 && vy === 0) return false;
    const prevX = me.x;
    const prevY = me.y;
    const newX = clamp(me.x + vx * dt, PLAYER_RADIUS, MAP_WIDTH - PLAYER_RADIUS);
    const newY = clamp(me.y + vy * dt, PLAYER_RADIUS, MAP_HEIGHT - PLAYER_RADIUS);
    if (canOccupy(newX, me.y, COLLISION_RADIUS)) me.x = newX;
    if (canOccupy(me.x, newY, COLLISION_RADIUS)) me.y = newY;
    me.targetX = me.x;
    me.targetY = me.y;
    return me.x !== prevX || me.y !== prevY;
  }

  // Advances along the click-to-move waypoints at boosted speed. Returns the
  // velocity applied this frame (zero on arrival) so the caller can broadcast it.
  private followPath(me: PlayerState, dt: number): { vx: number; vy: number } {
    if (!this.movePath) return { vx: 0, vy: 0 };
    const target = this.movePath[this.moveIndex];
    const ddx = target.x - me.x;
    const ddy = target.y - me.y;
    const dist = Math.hypot(ddx, ddy);
    if (dist <= CLICK_MOVE_ARRIVE_THRESHOLD) {
      this.moveIndex++;
      if (this.moveIndex >= this.movePath.length) this.movePath = null;
      return { vx: 0, vy: 0 };
    }
    // Cap the speed so a large frame step never overshoots the waypoint.
    const speed = Math.min(PLAYER_SPEED * CLICK_MOVE_MULTIPLIER, dist / dt);
    const vx = (ddx / dist) * speed;
    const vy = (ddy / dist) * speed;
    if (!this.applyVelocity(me, vx, vy, dt)) {
      // Unexpectedly blocked: abandon the route and stop.
      this.movePath = null;
      return { vx: 0, vy: 0 };
    }
    return { vx, vy };
  }
}

function clamp(v: number, lo: number, hi: number) {
  return v < lo ? lo : v > hi ? hi : v;
}
