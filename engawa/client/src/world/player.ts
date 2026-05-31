import { EXTRAP_MAX_MS, INTERP_DECAY, type Player, type PlayerStatus } from '@/core/types';
import { type Direction, defaultOutfit, type Outfit } from '@/world/outfit';

export class PlayerState implements Player {
  userId: string;
  name: string;

  // Rendered position (interpolated).
  x: number;
  y: number;

  // Last authoritative position received from the network.
  targetX: number;
  targetY: number;
  // Velocity at the time of the last update — used to predict where the
  // remote player is *now* instead of where they were when the message left.
  vx = 0;
  vy = 0;
  // performance.now() of the last update.
  lastUpdate = 0;

  color: string;
  isSelf: boolean;
  status: PlayerStatus = 'online';
  // Optional status one-liner and return time (epoch ms, null = none) (#85).
  note = '';
  until: number | null = null;
  isSpeaking = false;
  isMuted = false;
  isVideoOn = false;
  isSharingScreen = false;

  // Modular avatar configuration (#141) and the facing it last moved in. The
  // renderer composites `outfit` into a sprite; `facing` picks the direction row.
  outfit: Outfit;
  facing: Direction = 'down';

  constructor(p: Player, isSelf: boolean) {
    this.userId = p.userId;
    this.name = p.name;
    this.x = p.x;
    this.y = p.y;
    this.targetX = p.x;
    this.targetY = p.y;
    this.lastUpdate = performance.now();
    this.isSelf = isSelf;
    this.color = colorForId(p.userId);
    this.outfit = p.outfit ?? defaultOutfit();
  }

  setTarget(x: number, y: number, vx: number, vy: number) {
    this.targetX = x;
    this.targetY = y;
    this.vx = vx;
    this.vy = vy;
    this.lastUpdate = performance.now();
    this.updateFacing(vx, vy);
  }

  // Update the facing from a velocity (no change while stationary, so an idle
  // avatar keeps looking where it last moved). Dominant axis wins.
  updateFacing(vx: number, vy: number) {
    if (vx === 0 && vy === 0) return;
    if (Math.abs(vx) > Math.abs(vy)) this.facing = vx < 0 ? 'left' : 'right';
    else this.facing = vy < 0 ? 'up' : 'down';
  }

  // dt is seconds elapsed since the previous frame.
  interpolate(dt: number) {
    // Predict where the remote player should be *right now* by extrapolating
    // from the last known position + velocity, capped to avoid runaway when
    // the network drops.
    const elapsedMs = performance.now() - this.lastUpdate;
    const extrapMs = Math.min(EXTRAP_MAX_MS, elapsedMs);
    const t = extrapMs / 1000;
    const predX = this.targetX + this.vx * t;
    const predY = this.targetY + this.vy * t;

    // Frame-rate independent exponential ease toward the predicted position.
    const alpha = 1 - Math.exp(-INTERP_DECAY * dt);
    this.x += (predX - this.x) * alpha;
    this.y += (predY - this.y) * alpha;
  }

  initials() {
    const name = this.name || '?';
    const parts = name.trim().split(/\s+/);
    if (parts.length >= 2) {
      return (parts[0][0] + parts[1][0]).toUpperCase();
    }
    return name.slice(0, 2).toUpperCase();
  }
}

function colorForId(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) | 0;
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 65%, 55%)`;
}
