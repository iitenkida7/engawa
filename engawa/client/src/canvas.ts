import { MAP_WIDTH, MAP_HEIGHT, PLAYER_RADIUS, CONNECT_RADIUS } from './types';
import type { PlayerState } from './player';
import type { Point } from './proximity';
import {
  TILE_SIZE,
  MAP_COLS,
  MAP_ROWS,
  officeMap,
  TILE_FILL,
  TILE_BORDER,
  Tile,
  ZONES,
  zoneAt,
} from './tilemap';

// Emoji shown as the avatar status badge, matching the toolbar menu labels.
// `online` has no badge.
const STATUS_BADGE: Record<string, string> = {
  busy: '🔴', away: '🟡', meeting: '🤝', break: '☕',
};

/**
 * Convert a screen/client coordinate to a world coordinate. Pure (no DOM) so
 * the camera-offset math can be unit-tested; the camera centers on `self`,
 * matching render()'s `camX = self.x - viewW/2`.
 */
export function worldFromScreen(
  screenX: number,
  screenY: number,
  rect: { left: number; top: number },
  view: { w: number; h: number },
  self: Point | null,
): Point {
  const camX = self ? self.x - view.w / 2 : MAP_WIDTH / 2 - view.w / 2;
  const camY = self ? self.y - view.h / 2 : MAP_HEIGHT / 2 - view.h / 2;
  return { x: screenX - rect.left + camX, y: screenY - rect.top + camY };
}

export class CanvasRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private dpr: number;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2d context not available');
    this.ctx = ctx;
    this.dpr = window.devicePixelRatio || 1;
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  resize() {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    this.canvas.width = Math.floor(w * this.dpr);
    this.canvas.height = Math.floor(h * this.dpr);
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  get viewW() {
    return this.canvas.clientWidth;
  }
  get viewH() {
    return this.canvas.clientHeight;
  }

  /** Map a click position (clientX/Y) to a world coordinate. */
  screenToWorld(clientX: number, clientY: number, self: PlayerState | null): Point {
    const rect = this.canvas.getBoundingClientRect();
    return worldFromScreen(clientX, clientY, rect, { w: this.viewW, h: this.viewH }, self);
  }

  render(
    self: PlayerState | null,
    players: Iterable<PlayerState>,
    moveTarget: Point | null = null,
    highlightId: string | null = null,
  ) {
    const ctx = this.ctx;
    const w = this.viewW;
    const h = this.viewH;
    ctx.clearRect(0, 0, w, h);

    // Camera: center on self
    const camX = self ? self.x - w / 2 : MAP_WIDTH / 2 - w / 2;
    const camY = self ? self.y - h / 2 : MAP_HEIGHT / 2 - h / 2;

    ctx.save();
    ctx.translate(-camX, -camY);

    // Tile map — only draw tiles visible in the viewport
    const startCol = Math.max(0, Math.floor(camX / TILE_SIZE));
    const endCol = Math.min(MAP_COLS - 1, Math.floor((camX + w) / TILE_SIZE));
    const startRow = Math.max(0, Math.floor(camY / TILE_SIZE));
    const endRow = Math.min(MAP_ROWS - 1, Math.floor((camY + h) / TILE_SIZE));

    for (let r = startRow; r <= endRow; r++) {
      for (let c = startCol; c <= endCol; c++) {
        const tile = officeMap[r][c];
        const tx = c * TILE_SIZE;
        const ty = r * TILE_SIZE;

        ctx.fillStyle = TILE_FILL[tile] ?? TILE_FILL[Tile.FLOOR];
        ctx.fillRect(tx, ty, TILE_SIZE, TILE_SIZE);

        const border = TILE_BORDER[tile];
        if (border) {
          ctx.strokeStyle = border;
          ctx.lineWidth = 1;
          ctx.strokeRect(tx + 0.5, ty + 0.5, TILE_SIZE - 1, TILE_SIZE - 1);
        }

        // Subtle grid line on floor / meeting / lounge tiles
        if (tile === Tile.FLOOR || tile === Tile.MEETING || tile === Tile.LOUNGE) {
          ctx.strokeStyle = 'rgba(255,255,255,0.03)';
          ctx.lineWidth = 1;
          ctx.strokeRect(tx + 0.5, ty + 0.5, TILE_SIZE - 1, TILE_SIZE - 1);
        }

        // Plant decoration: draw a small circle
        if (tile === Tile.PLANT) {
          ctx.beginPath();
          ctx.arc(tx + TILE_SIZE / 2, ty + TILE_SIZE / 2, TILE_SIZE * 0.3, 0, Math.PI * 2);
          ctx.fillStyle = '#4a8a4a';
          ctx.fill();
        }
      }
    }

    // map border
    ctx.strokeStyle = '#3a4050';
    ctx.lineWidth = 2;
    ctx.strokeRect(0, 0, MAP_WIDTH, MAP_HEIGHT);

    // Meeting-room zones: frame + name label, highlighted while self is inside.
    const selfZone = self ? zoneAt(self.x, self.y) : null;
    for (const zone of ZONES) {
      this.drawZone(ctx, zone, selfZone?.id === zone.id);
    }

    // Self proximity ring — hidden inside a meeting room, where the call is
    // governed by room membership (everyone in / nobody out), not radius.
    if (self && !selfZone) {
      ctx.beginPath();
      ctx.arc(self.x, self.y, CONNECT_RADIUS, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(79,140,255,0.08)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(79,140,255,0.25)';
      ctx.lineWidth = 1;
      ctx.setLineDash([6, 4]);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // click-to-move destination marker (only while travelling)
    if (moveTarget) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(moveTarget.x, moveTarget.y, 12, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(79,140,255,0.15)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(79,140,255,0.7)';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(moveTarget.x, moveTarget.y, 3, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(79,140,255,0.9)';
      ctx.fill();
      ctx.restore();
    }

    // players
    const sortedPlayers = [...players].sort((a, b) => a.y - b.y);
    for (const p of sortedPlayers) {
      this.drawPlayer(ctx, p, p.userId === highlightId);
    }

    ctx.restore();
  }

  private drawZone(ctx: CanvasRenderingContext2D, zone: { name: string; x: number; y: number; w: number; h: number }, active: boolean) {
    // Frame: brighter when self is inside so "in this room" is obvious.
    ctx.save();
    ctx.strokeStyle = active ? 'rgba(79,140,255,0.9)' : 'rgba(79,140,255,0.4)';
    ctx.lineWidth = active ? 3 : 2;
    ctx.strokeRect(zone.x + 1, zone.y + 1, zone.w - 2, zone.h - 2);

    // Name label, top-left inside the frame.
    ctx.font = 'bold 13px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    const label = `🚪 ${zone.name}`;
    const m = ctx.measureText(label);
    const padX = 6;
    const lh = 20;
    ctx.fillStyle = active ? 'rgba(79,140,255,0.9)' : 'rgba(20,23,30,0.8)';
    this.roundRect(ctx, zone.x + 4, zone.y + 4, m.width + padX * 2, lh, 4);
    ctx.fill();
    ctx.fillStyle = 'white';
    ctx.fillText(label, zone.x + 4 + padX, zone.y + 4 + 4);
    ctx.restore();
  }

  private drawPlayer(ctx: CanvasRenderingContext2D, p: PlayerState, highlighted = false) {
    // Roster focus ring: a pulsing amber halo behind the avatar so a player
    // picked from the participant list stands out on the map.
    if (highlighted) {
      const t = (Math.sin(performance.now() / 250) + 1) / 2;
      ctx.beginPath();
      ctx.arc(p.x, p.y, PLAYER_RADIUS + 8 + t * 4, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255,196,0,${0.12 + t * 0.12})`;
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,196,0,0.9)';
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    // shadow
    ctx.beginPath();
    ctx.ellipse(p.x, p.y + PLAYER_RADIUS + 2, PLAYER_RADIUS * 0.8, 4, 0, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fill();

    // body circle
    ctx.beginPath();
    ctx.arc(p.x, p.y, PLAYER_RADIUS, 0, Math.PI * 2);
    ctx.fillStyle = p.color;
    ctx.fill();

    // border
    ctx.lineWidth = p.isSelf ? 4 : 2;
    ctx.strokeStyle = p.isSelf ? '#4f8cff' : 'rgba(0,0,0,0.5)';
    ctx.stroke();

    // speaking indicator
    if (p.isSpeaking) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, PLAYER_RADIUS + 5, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(80,220,120,0.9)';
      ctx.lineWidth = 3;
      ctx.stroke();
    }

    // initials
    ctx.fillStyle = 'white';
    ctx.font = 'bold 14px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(p.initials(), p.x, p.y);

    // Status badge (top-right of avatar). Show the status emoji — matching the
    // toolbar menu — so meeting/break read clearly, not just as a colored dot.
    const badge = STATUS_BADGE[p.status];
    if (badge) {
      const bx = p.x + PLAYER_RADIUS * 0.7;
      const by = p.y - PLAYER_RADIUS * 0.7;
      ctx.font = '14px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(badge, bx, by);
    }

    // name label
    ctx.font = '12px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    const label = p.name + (p.isSharingScreen ? '  🖥' : '');
    const m = ctx.measureText(label);
    const padX = 6;
    const lw = m.width + padX * 2;
    const lh = 18;
    const ly = p.y + PLAYER_RADIUS + 8;
    ctx.fillStyle = 'rgba(0,0,0,0.65)';
    this.roundRect(ctx, p.x - lw / 2, ly, lw, lh, 4);
    ctx.fill();
    ctx.fillStyle = 'white';
    ctx.fillText(label, p.x, ly + lh / 2 + 1);
  }

  private roundRect(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    w: number,
    h: number,
    r: number,
  ) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
}
