import {
  MAP_WIDTH,
  MAP_HEIGHT,
  PLAYER_RADIUS,
  CONNECT_RADIUS,
  REACTION_LIFETIME_MS,
  ZOOM_MIN,
  ZOOM_MAX,
  ZOOM_STEP,
} from '@/core/types';
import type { PlayerState } from '@/world/player';
import type { Point } from '@/core/proximity';
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
} from '@/world/tilemap';
import { SpriteSheet } from '@/world/sprites';
import { CELL, floorKindAt, propFor } from '@/world/decor';

// Emoji shown as the avatar status badge, matching the toolbar menu labels.
// `online` has no badge.
const STATUS_BADGE: Record<string, string> = {
  busy: '🔴', away: '🟡', meeting: '🤝', break: '☕',
};

// Max chars of the status one-liner shown above an avatar (#85); longer notes
// are truncated with an ellipsis. The full text stays in the roster.
const AVATAR_NOTE_MAX = 12;

/**
 * Pure: shorten a status one-liner for the above-avatar label. Trims, then caps
 * to `max` chars with a trailing ellipsis. '' (or whitespace-only) yields ''.
 */
export function truncateNote(note: string, max = AVATAR_NOTE_MAX): string {
  const t = note.trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

// How far (world px) a reaction bubble drifts upward over its lifetime.
const REACTION_RISE_PX = 36;

/**
 * Animation state of a floating reaction `elapsed` ms into its `lifetime`.
 * Pure (no DOM) so the float/fade curve is unit-testable. Returns null once the
 * reaction has expired; otherwise alpha fades 1→0 and rise grows 0→REACTION_RISE_PX.
 */
export function reactionAnim(
  elapsed: number,
  lifetime = REACTION_LIFETIME_MS,
): { alpha: number; rise: number } | null {
  if (elapsed < 0 || elapsed >= lifetime) return null;
  const t = elapsed / lifetime;
  return { alpha: 1 - t, rise: REACTION_RISE_PX * t };
}

/**
 * Convert a screen/client coordinate to a world coordinate. Pure (no DOM) so
 * the camera math can be unit-tested. The camera centers on `self` and applies
 * `zoom` about that center, inverting render()'s transform
 * (translate center → scale → translate -self): a click `d` px from the
 * viewport center is `d / zoom` world px from self.
 */
export function worldFromScreen(
  screenX: number,
  screenY: number,
  rect: { left: number; top: number },
  view: { w: number; h: number },
  self: Point | null,
  zoom = 1,
): Point {
  const cx = self ? self.x : MAP_WIDTH / 2;
  const cy = self ? self.y : MAP_HEIGHT / 2;
  return {
    x: (screenX - rect.left - view.w / 2) / zoom + cx,
    y: (screenY - rect.top - view.h / 2) / zoom + cy,
  };
}

export class CanvasRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private dpr: number;

  // The static map (floors/walls/furniture/border/vignette) is baked once into
  // this offscreen world-space canvas and blitted per frame, so a richer map is
  // actually cheaper than the old per-tile loop. Rebuilt only when the sprite
  // sheet finishes loading or the device pixel ratio changes (it is otherwise
  // viewport-independent). null = needs (re)build.
  private sheet = new SpriteSheet();
  private mapCache: HTMLCanvasElement | null = null;
  private mapCacheDpr = 0;

  // Zoom-out factor about the self-centered camera. ZOOM_MAX (1.0) is the
  // default 1:1 view; smaller surveys more of the office. The map cache is
  // viewport-independent, so zooming never invalidates it.
  private zoomLevel = ZOOM_MAX;

  // Live emoji reactions, anchored to a userId so the bubble tracks that avatar
  // as it moves. Each is drawn floating up + fading; expired ones are pruned in
  // render(). Memory-only, like everything else here.
  private reactions: { userId: string; emoji: string; start: number }[] = [];

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2d context not available');
    this.ctx = ctx;
    this.dpr = window.devicePixelRatio || 1;
    this.resize();
    window.addEventListener('resize', () => this.resize());
    // Rebuild the cache with real sprites once the tilesheet loads.
    this.sheet.whenReady(() => {
      this.mapCache = null;
    });
  }

  resize() {
    // Refresh dpr (it can change when the window moves between monitors) and
    // invalidate the cache if it did, so the baked layer stays crisp.
    const dpr = window.devicePixelRatio || 1;
    if (dpr !== this.dpr) {
      this.dpr = dpr;
      this.mapCache = null;
    }
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

  get canZoomIn() {
    return this.zoomLevel < ZOOM_MAX;
  }
  get canZoomOut() {
    return this.zoomLevel > ZOOM_MIN;
  }
  /** Step the camera out (−) / in (+) one notch, clamped to [MIN, MAX]. */
  zoomOut() {
    this.setZoom(this.zoomLevel / ZOOM_STEP);
  }
  zoomIn() {
    this.setZoom(this.zoomLevel * ZOOM_STEP);
  }
  private setZoom(z: number) {
    this.zoomLevel = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
  }

  /** Queue a floating emoji reaction above the given player's avatar. */
  addReaction(userId: string, emoji: string) {
    this.reactions.push({ userId, emoji, start: performance.now() });
  }

  /** Map a click position (clientX/Y) to a world coordinate. */
  screenToWorld(clientX: number, clientY: number, self: PlayerState | null): Point {
    const rect = this.canvas.getBoundingClientRect();
    return worldFromScreen(
      clientX,
      clientY,
      rect,
      { w: this.viewW, h: this.viewH },
      self,
      this.zoomLevel,
    );
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

    // Camera centers on self (or the map center before join) and zooms about it.
    const zoom = this.zoomLevel;
    const centerX = self ? self.x : MAP_WIDTH / 2;
    const centerY = self ? self.y : MAP_HEIGHT / 2;
    // World rectangle currently visible — covers more world the further we zoom
    // out (view / zoom). Used for fallback tile culling and matches the inverse
    // in worldFromScreen().
    const visW = w / zoom;
    const visH = h / zoom;
    const camX = centerX - visW / 2;
    const camY = centerY - visH / 2;

    ctx.save();
    // Move origin to the viewport center, scale, then put self at the origin, so
    // self stays centered and only the scale changes (inverse: worldFromScreen).
    ctx.translate(w / 2, h / 2);
    ctx.scale(zoom, zoom);
    ctx.translate(-centerX, -centerY);

    // Static map layer: one cached blit once the tilesheet has loaded; until
    // then, fall back to the procedural per-tile draw so the map is never blank.
    // The cache is full-map world space, so drawing it under the existing
    // camera translate lets the browser clip the offscreen part for free.
    const dpr = Math.min(this.dpr, 2);
    if (this.sheet.ready) {
      if (!this.mapCache || this.mapCacheDpr !== dpr) this.buildMapCache(dpr);
      // Blit at LOGICAL map size — the destination ctx is already dpr-scaled, so
      // passing device px here would double-scale.
      ctx.drawImage(this.mapCache as HTMLCanvasElement, 0, 0, MAP_WIDTH, MAP_HEIGHT);
    } else {
      this.drawTilesFallback(ctx, camX, camY, visW, visH);
    }

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

    // Floating emoji reactions, on top of the avatars they belong to.
    this.drawReactions(ctx, sortedPlayers);

    ctx.restore();
  }

  // Draw each live reaction floating above its player's head, fading as it
  // rises, and prune the ones that have expired. A reaction whose player has
  // left is simply not drawn but still ages out.
  private drawReactions(ctx: CanvasRenderingContext2D, players: PlayerState[]) {
    if (this.reactions.length === 0) return;
    const now = performance.now();
    const byId = new Map(players.map((p) => [p.userId, p]));
    const alive: typeof this.reactions = [];
    for (const r of this.reactions) {
      const anim = reactionAnim(now - r.start);
      if (!anim) continue;
      alive.push(r);
      const p = byId.get(r.userId);
      if (!p) continue;
      ctx.save();
      ctx.globalAlpha = anim.alpha;
      ctx.font = '28px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(r.emoji, p.x, p.y - PLAYER_RADIUS - 18 - anim.rise);
      ctx.restore();
    }
    this.reactions = alive;
  }

  // Bakes the whole static map into an offscreen world-space canvas: sprite
  // floors (wood in the open office, carpet in rooms), procedural beveled walls,
  // desk/plant sprites, the map border, and a corner vignette. Runs once (and on
  // dpr change); the per-frame path is a single drawImage of this.
  private buildMapCache(dpr: number) {
    const cache = document.createElement('canvas');
    cache.width = Math.round(MAP_WIDTH * dpr);
    cache.height = Math.round(MAP_HEIGHT * dpr);
    const cx = cache.getContext('2d')!;
    cx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // Crisp pixel art when scaling the 16px sprites up to 50px tiles.
    cx.imageSmoothingEnabled = false;

    for (let r = 0; r < MAP_ROWS; r++) {
      for (let c = 0; c < MAP_COLS; c++) {
        const tile = officeMap[r][c];
        const tx = c * TILE_SIZE;
        const ty = r * TILE_SIZE;
        if (tile === Tile.WALL) {
          this.drawWall(cx, tx, ty);
          continue;
        }
        // Floor first (rooms read as carpet, the open office as wood)...
        const floor = floorKindAt(c, r) === 'carpet' ? CELL.carpetFloor : CELL.woodFloor;
        this.sheet.draw(cx, floor[0], floor[1], tx, ty, TILE_SIZE);
        // ...then the prop on top, if this tile carries one.
        const prop = propFor(tile);
        if (prop === 'desk') this.sheet.draw(cx, CELL.desk[0], CELL.desk[1], tx, ty, TILE_SIZE);
        else if (prop === 'plant') this.sheet.draw(cx, CELL.plant[0], CELL.plant[1], tx, ty, TILE_SIZE);
      }
    }

    // Map border.
    cx.strokeStyle = '#3a4050';
    cx.lineWidth = 2;
    cx.strokeRect(0, 0, MAP_WIDTH, MAP_HEIGHT);

    // Corner vignette for a touch of depth.
    const g = cx.createRadialGradient(
      MAP_WIDTH / 2, MAP_HEIGHT / 2, Math.min(MAP_WIDTH, MAP_HEIGHT) * 0.35,
      MAP_WIDTH / 2, MAP_HEIGHT / 2, Math.max(MAP_WIDTH, MAP_HEIGHT) * 0.6,
    );
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, 'rgba(0,0,0,0.28)');
    cx.fillStyle = g;
    cx.fillRect(0, 0, MAP_WIDTH, MAP_HEIGHT);

    this.mapCache = cache;
    this.mapCacheDpr = dpr;
  }

  // A wall tile drawn procedurally (the Kenney pack has no wall tiles): a dark
  // base with a lit top edge and a dark bottom edge for a paneled, 3D feel.
  private drawWall(cx: CanvasRenderingContext2D, tx: number, ty: number) {
    cx.fillStyle = TILE_FILL[Tile.WALL];
    cx.fillRect(tx, ty, TILE_SIZE, TILE_SIZE);
    cx.fillStyle = 'rgba(255,255,255,0.05)';
    cx.fillRect(tx, ty, TILE_SIZE, 3);
    cx.fillStyle = 'rgba(0,0,0,0.35)';
    cx.fillRect(tx, ty + TILE_SIZE - 4, TILE_SIZE, 4);
    cx.strokeStyle = '#252830';
    cx.lineWidth = 1;
    cx.strokeRect(tx + 0.5, ty + 0.5, TILE_SIZE - 1, TILE_SIZE - 1);
  }

  // The original flat per-tile rendering, used only until the sprite sheet
  // loads (or if it fails to). Visible-range culled, matching the old behaviour.
  private drawTilesFallback(ctx: CanvasRenderingContext2D, camX: number, camY: number, w: number, h: number) {
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

        if (tile === Tile.FLOOR || tile === Tile.MEETING || tile === Tile.LOUNGE) {
          ctx.strokeStyle = 'rgba(255,255,255,0.03)';
          ctx.lineWidth = 1;
          ctx.strokeRect(tx + 0.5, ty + 0.5, TILE_SIZE - 1, TILE_SIZE - 1);
        }

        if (tile === Tile.PLANT) {
          ctx.beginPath();
          ctx.arc(tx + TILE_SIZE / 2, ty + TILE_SIZE / 2, TILE_SIZE * 0.3, 0, Math.PI * 2);
          ctx.fillStyle = '#4a8a4a';
          ctx.fill();
        }
      }
    }

    ctx.strokeStyle = '#3a4050';
    ctx.lineWidth = 2;
    ctx.strokeRect(0, 0, MAP_WIDTH, MAP_HEIGHT);
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

    // Status one-liner (#85): a small pill above the avatar, so "なぜ離れている
    // か" reads at a glance on the map. Truncated; the return time lives in the
    // roster. Reactions float in the same area but are transient and on top.
    const note = truncateNote(p.note);
    if (note) {
      ctx.font = '11px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
      const nm = ctx.measureText(note);
      const nlw = nm.width + padX * 2;
      const nlh = 16;
      const ny = p.y - PLAYER_RADIUS - 6 - nlh;
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      this.roundRect(ctx, p.x - nlw / 2, ny, nlw, nlh, 4);
      ctx.fill();
      ctx.fillStyle = '#ffe7a3';
      ctx.fillText(note, p.x, ny + nlh / 2 + 1);
    }
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
