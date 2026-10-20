import type { Point } from '@/core/proximity';
import {
  CLICK_MOVE_ARRIVE_THRESHOLD,
  CLICK_MOVE_MULTIPLIER,
  COLLISION_RADIUS,
  MAP_HEIGHT,
  MAP_WIDTH,
  PLAYER_RADIUS,
  PLAYER_SPEED,
  STEP_DURATION_MS,
} from '@/core/types';
import { stepTarget } from '@/world/grid';
import { findPath } from '@/world/pathfind';
import type { PlayerState } from '@/world/player';
import { canOccupy } from '@/world/tilemap';

// Self movement, split out of App: grid-step keyboard movement (issue #206) and
// click-to-move along an A* route. It only moves our own PlayerState; App reads
// the returned velocity to broadcast it.
export class MovementController {
  // Click-to-move: remaining waypoint tile-centers and the current index.
  private path: Point[] | null = null;
  private index = 0;

  // Grid-step keyboard movement (issue #206): the active one-tile slide, or null
  // when idle. While a step is in progress new keyboard input is ignored, so the
  // avatar always comes to rest on a tile center.
  private gridStep: {
    fromX: number;
    fromY: number;
    toX: number;
    toY: number;
    elapsed: number;
  } | null = null;

  // Final waypoint of the active click-to-move route (drawn as the destination
  // marker), or null when not walking a route.
  get destination(): Point | null {
    return this.path ? this.path[this.path.length - 1] : null;
  }

  // Route `me` to `goal` (A* around walls). Returns false, clearing any route,
  // when there is no path.
  walkTo(me: PlayerState, goal: Point): boolean {
    const path = findPath({ x: me.x, y: me.y }, goal);
    if (path.length === 0) {
      this.path = null;
      return false;
    }
    this.path = path;
    this.index = 0;
    return true;
  }

  // Move `me` for one frame. A step in progress slides to the next tile center;
  // only once it finishes is `readDirection` consulted for the next step. Manual
  // keyboard input cancels click-to-move and takes over. Returns the velocity
  // applied this frame so the caller can broadcast it.
  update(
    me: PlayerState,
    dt: number,
    readDirection: () => { dx: number; dy: number },
  ): { vx: number; vy: number } {
    if (this.gridStep) return this.advanceStep(me, dt);
    const { dx, dy } = readDirection();
    if (dx !== 0 || dy !== 0) {
      this.path = null;
      // Turn to face the pressed direction even if the next tile is blocked.
      me.updateFacing(dx, dy);
      const target = stepTarget(me.x, me.y, dx, dy);
      if (!target) return { vx: 0, vy: 0 };
      this.gridStep = { fromX: me.x, fromY: me.y, toX: target.x, toY: target.y, elapsed: 0 };
      return this.advanceStep(me, dt);
    }
    if (this.path) return this.followPath(me, dt);
    return { vx: 0, vy: 0 };
  }

  // Advances the active grid step for one frame, linearly interpolating from the
  // step's origin tile toward the destination tile center over STEP_DURATION_MS.
  // Clears the step (snapping exactly onto the target) when it completes.
  private advanceStep(me: PlayerState, dt: number): { vx: number; vy: number } {
    const s = this.gridStep;
    if (!s) return { vx: 0, vy: 0 };
    s.elapsed += dt;
    const dur = STEP_DURATION_MS / 1000;
    const p = Math.min(1, s.elapsed / dur);
    const prevX = me.x;
    const prevY = me.y;
    me.x = s.fromX + (s.toX - s.fromX) * p;
    me.y = s.fromY + (s.toY - s.fromY) * p;
    me.targetX = me.x;
    me.targetY = me.y;
    const vx = dt > 0 ? (me.x - prevX) / dt : 0;
    const vy = dt > 0 ? (me.y - prevY) / dt : 0;
    if (p >= 1) this.gridStep = null;
    return { vx, vy };
  }

  // Advances along the click-to-move waypoints at boosted speed. Returns the
  // velocity applied this frame (zero on arrival).
  private followPath(me: PlayerState, dt: number): { vx: number; vy: number } {
    if (!this.path) return { vx: 0, vy: 0 };
    const target = this.path[this.index];
    const ddx = target.x - me.x;
    const ddy = target.y - me.y;
    const dist = Math.hypot(ddx, ddy);
    if (dist <= CLICK_MOVE_ARRIVE_THRESHOLD) {
      this.index++;
      if (this.index >= this.path.length) this.path = null;
      return { vx: 0, vy: 0 };
    }
    // Cap the speed so a large frame step never overshoots the waypoint.
    const speed = Math.min(PLAYER_SPEED * CLICK_MOVE_MULTIPLIER, dist / dt);
    const vx = (ddx / dist) * speed;
    const vy = (ddy / dist) * speed;
    if (!applyVelocity(me, vx, vy, dt)) {
      // Unexpectedly blocked: abandon the route and stop.
      this.path = null;
      return { vx: 0, vy: 0 };
    }
    return { vx, vy };
  }
}

// Moves `me` by a velocity for one frame, sliding along walls (per-axis
// canOccupy). Returns whether the position actually changed.
function applyVelocity(me: PlayerState, vx: number, vy: number, dt: number): boolean {
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

function clamp(v: number, lo: number, hi: number) {
  return v < lo ? lo : v > hi ? hi : v;
}
