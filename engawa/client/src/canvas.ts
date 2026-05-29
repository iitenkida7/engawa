import { MAP_WIDTH, MAP_HEIGHT, PLAYER_RADIUS, CONNECT_RADIUS } from './types';
import type { PlayerState } from './player';
import {
  TILE_SIZE,
  MAP_COLS,
  MAP_ROWS,
  officeMap,
  TILE_FILL,
  TILE_BORDER,
  Tile,
} from './tilemap';

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

  render(self: PlayerState | null, players: Iterable<PlayerState>) {
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

    // self proximity ring
    if (self) {
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

    // players
    const sortedPlayers = [...players].sort((a, b) => a.y - b.y);
    for (const p of sortedPlayers) {
      this.drawPlayer(ctx, p);
    }

    ctx.restore();
  }

  private drawPlayer(ctx: CanvasRenderingContext2D, p: PlayerState) {
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

    // Status dot (top-right of avatar)
    if (p.status && p.status !== 'online') {
      const dotX = p.x + PLAYER_RADIUS * 0.65;
      const dotY = p.y - PLAYER_RADIUS * 0.65;
      ctx.beginPath();
      ctx.arc(dotX, dotY, 5, 0, Math.PI * 2);
      ctx.fillStyle = p.status === 'busy' ? '#dc3545' : '#ffc107';
      ctx.fill();
      ctx.strokeStyle = '#1a1d24';
      ctx.lineWidth = 2;
      ctx.stroke();
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
