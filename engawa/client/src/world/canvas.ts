import type { Point } from '@/core/proximity';
import {
  CONNECT_RADIUS,
  MAP_HEIGHT,
  MAP_WIDTH,
  PLAYER_RADIUS,
  REACTION_LIFETIME_MS,
  ZOOM_MAX,
  ZOOM_MIN,
  ZOOM_STEP,
} from '@/core/types';
import { CharacterSheet } from '@/world/character';
import { floorKindAt, propFor } from '@/world/decor';
import type { PlayerState } from '@/world/player';
import {
  MAP_COLS,
  MAP_ROWS,
  officeMap,
  ROOM_FURNITURE,
  type RoomFurniture,
  TILE_SIZE,
  Tile,
  ZONES,
  zoneAt,
} from '@/world/tilemap';

// ─── Interior theme: 北欧ミニマル / 青山カフェ ───────────────────────────────
// Clean, bright, natural. Light oak plank floors in the open office, soft cream
// rugs in the meeting rooms, warm off-white walls, minimal white desks, and sage
// plants in terracotta pots. Drawn procedurally (no tile sprites), so there are
// no pixel-art patterns and nothing to license for the map.
const PALETTE = {
  floorWood: '#e8dcc8', // open-office oak
  floorWoodSeam: 'rgba(196,178,148,0.45)',
  floorRug: '#efe9e0', // meeting-room cream rug
  wall: '#d3c8b2', // warm taupe wall
  wallHi: 'rgba(255,255,255,0.45)',
  wallShadow: 'rgba(120,105,80,0.20)',
  wallSeam: 'rgba(150,136,110,0.4)',
  deskTop: '#fbfbf9',
  deskEdge: '#d8c6a4',
  monitor: '#3b414c',
  monitorScreen: '#6f93a3',
  tableTop: '#f4efe6', // meeting-table surface (warm off-white)
  chair: '#8f9c8a', // sage-gray chairs around meeting tables
  pot: '#c98a5e',
  potShade: '#b2764a',
  leaf: '#7d9b6a',
  leafDark: '#688457',
  border: '#cabfa8',
} as const;

// Emoji shown as the avatar status badge, matching the toolbar menu labels.
// `online` has no badge.
const STATUS_BADGE: Record<string, string> = {
  busy: '🔴',
  away: '🟡',
  meeting: '🤝',
  break: '☕',
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

// Composited-avatar display scale: the 64px source frame is drawn at this size
// (1:1 keeps the pixel art crisp). Feet are planted on the shadow so the avatar
// stands on its map spot.
const SPRITE_SCALE = 1;

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

  // The static map (floors/walls/furniture/border) is baked once into this
  // offscreen world-space canvas and blitted per frame, so a richer map is
  // actually cheaper than a per-tile loop. Rebuilt only when the device pixel
  // ratio changes (it is otherwise viewport-independent). null = needs (re)build.
  // Modular avatar sprites (#141). Until it loads, drawPlayer falls back to the
  // colored circle + initials below.
  private characters = new CharacterSheet();
  private mapCache: HTMLCanvasElement | null = null;
  private mapCacheDpr = 0;

  // Zoom-out factor about the camera center. ZOOM_MAX (1.0) is the default 1:1
  // view; smaller surveys more of the office. The map cache is
  // viewport-independent, so zooming never invalidates it.
  private zoomLevel = ZOOM_MAX;

  // Camera center (world px). While `following` (the default) it tracks self each
  // frame; dragging the map turns following off and pans camX/camY freely
  // (clamped to the map), and any self-movement re-centers (recenter()).
  private camX = MAP_WIDTH / 2;
  private camY = MAP_HEIGHT / 2;
  private following = true;
  private dragging = false;
  private dragLastX = 0;
  private dragLastY = 0;

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
    this.setupPan();
  }

  // Drag the map to pan the view. A press starts a free-pan (stops following
  // self); each move shifts the camera by the drag delta (in world px, so it
  // tracks the cursor regardless of zoom), clamped so the map can't be lost.
  // Moving your avatar re-centers (see recenter(), called by the App). This is a
  // press-drag-release gesture, so it never conflicts with double-click-to-move.
  private setupPan() {
    this.canvas.style.cursor = 'grab';
    this.canvas.addEventListener('pointerdown', (e) => {
      this.dragging = true;
      this.following = false;
      this.dragLastX = e.clientX;
      this.dragLastY = e.clientY;
      this.canvas.style.cursor = 'grabbing';
      this.canvas.setPointerCapture(e.pointerId);
    });
    this.canvas.addEventListener('pointermove', (e) => {
      if (!this.dragging) return;
      this.camX -= (e.clientX - this.dragLastX) / this.zoomLevel;
      this.camY -= (e.clientY - this.dragLastY) / this.zoomLevel;
      this.dragLastX = e.clientX;
      this.dragLastY = e.clientY;
      this.camX = Math.max(0, Math.min(MAP_WIDTH, this.camX));
      this.camY = Math.max(0, Math.min(MAP_HEIGHT, this.camY));
    });
    const end = (e: PointerEvent) => {
      if (!this.dragging) return;
      this.dragging = false;
      this.canvas.style.cursor = 'grab';
      try {
        this.canvas.releasePointerCapture(e.pointerId);
      } catch {
        /* pointer already released */
      }
    };
    this.canvas.addEventListener('pointerup', end);
    this.canvas.addEventListener('pointercancel', end);
  }

  // Snap the camera back to self and resume following. Called by the App whenever
  // the local avatar moves, so acting re-centers the view after a pan.
  recenter() {
    this.following = true;
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

  /** Map a click position (clientX/Y) to a world coordinate, honoring the current
   * (possibly panned) camera center. */
  screenToWorld(clientX: number, clientY: number, _self: PlayerState | null): Point {
    const rect = this.canvas.getBoundingClientRect();
    return worldFromScreen(
      clientX,
      clientY,
      rect,
      { w: this.viewW, h: this.viewH },
      { x: this.camX, y: this.camY },
      this.zoomLevel,
    );
  }

  render(
    self: PlayerState | null,
    players: Iterable<PlayerState>,
    moveTarget: Point | null = null,
    highlightId: string | null = null,
    // Draw the media-reach ring only when the local user is actually publishing
    // something (mic / camera / screen). With nothing on it's just noise.
    mediaActive = false,
  ) {
    const ctx = this.ctx;
    const w = this.viewW;
    const h = this.viewH;
    ctx.clearRect(0, 0, w, h);

    // Camera: while following, track self (or the map center before join); while
    // panning, camX/camY are driven by the drag. Zoom is about the camera center.
    const zoom = this.zoomLevel;
    if (this.following) {
      this.camX = self ? self.x : MAP_WIDTH / 2;
      this.camY = self ? self.y : MAP_HEIGHT / 2;
    }
    const centerX = this.camX;
    const centerY = this.camY;

    ctx.save();
    // Move origin to the viewport center, scale, then put the camera center at the
    // origin, so it stays centered and only the scale changes (inverse:
    // worldFromScreen).
    ctx.translate(w / 2, h / 2);
    ctx.scale(zoom, zoom);
    ctx.translate(-centerX, -centerY);

    // Static map layer: baked once into an offscreen cache and blitted. The cache
    // is full-map world space, so drawing it under the existing camera translate
    // lets the browser clip the offscreen part for free.
    const dpr = Math.min(this.dpr, 2);
    if (!this.mapCache || this.mapCacheDpr !== dpr) this.buildMapCache(dpr);
    // Blit at LOGICAL map size — the destination ctx is already dpr-scaled, so
    // passing device px here would double-scale.
    ctx.drawImage(this.mapCache as HTMLCanvasElement, 0, 0, MAP_WIDTH, MAP_HEIGHT);

    // Meeting-room zones: frame + name label, highlighted while self is inside.
    const selfZone = self ? zoneAt(self.x, self.y) : null;
    for (const zone of ZONES) {
      this.drawZone(ctx, zone, selfZone?.id === zone.id);
    }

    // Self proximity ring — shown only while publishing media (the reach is
    // meaningless otherwise), and hidden inside a meeting room, where the call is
    // governed by room membership (everyone in / nobody out), not radius.
    if (self && !selfZone && mediaActive) {
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

  // Bakes the whole static map into an offscreen world-space canvas, drawn
  // procedurally in the 北欧ミニマル theme: light oak plank floors in the open
  // office, cream rugs in the meeting rooms, warm off-white walls, minimal white
  // desks, and sage plants in terracotta pots. Runs once (and on dpr change); the
  // per-frame path is a single drawImage of this.
  private buildMapCache(dpr: number) {
    const cache = document.createElement('canvas');
    cache.width = Math.round(MAP_WIDTH * dpr);
    cache.height = Math.round(MAP_HEIGHT * dpr);
    const cx = cache.getContext('2d')!;
    cx.setTransform(dpr, 0, 0, dpr, 0, 0);

    for (let r = 0; r < MAP_ROWS; r++) {
      for (let c = 0; c < MAP_COLS; c++) {
        const tile = officeMap[r][c];
        const tx = c * TILE_SIZE;
        const ty = r * TILE_SIZE;
        if (tile === Tile.WALL) {
          this.drawWall(cx, tx, ty);
          continue;
        }
        // Floor first (rooms read as a cream rug, the open office as oak)...
        const inRoom = floorKindAt(c, r) === 'carpet';
        if (inRoom) this.drawRugFloor(cx, tx, ty);
        else this.drawWoodFloor(cx, tx, ty);
        // ...then the prop on top. Open-office desks are workstations (monitor);
        // in-room desks are drawn as designed tables/chairs by the furniture pass
        // below, so skip them here.
        const prop = propFor(tile);
        if (prop === 'desk' && !inRoom) this.drawWorkstation(cx, tx, ty);
        else if (prop === 'plant') this.drawPlant(cx, tx, ty);
      }
    }

    // A chair in front of each open-office desk. Drawn in its own pass AFTER all
    // floors, because the seat sits just below the desk (extending into the next
    // tile) and would otherwise be painted over by that row's floor.
    for (let r = 0; r < MAP_ROWS; r++) {
      for (let c = 0; c < MAP_COLS; c++) {
        if (officeMap[r][c] === Tile.DESK && floorKindAt(c, r) === 'wood') {
          this.drawDeskChair(cx, c * TILE_SIZE, r * TILE_SIZE);
        }
      }
    }

    // Meeting-room furniture: proper tables with chairs (and an exec desk for the
    // president's office), drawn over the rug once the tiles are laid down.
    for (const f of ROOM_FURNITURE) this.drawRoomFurniture(cx, f);

    // Soft map border — a thin warm frame, no heavy vignette (a clean office is
    // bright, so the old dark corner shading is gone).
    cx.strokeStyle = PALETTE.border;
    cx.lineWidth = 2;
    cx.strokeRect(1, 1, MAP_WIDTH - 2, MAP_HEIGHT - 2);

    this.mapCache = cache;
    this.mapCacheDpr = dpr;
  }

  // A meeting room's furniture: a table with chairs around it (every room,
  // including the president's office).
  private drawRoomFurniture(cx: CanvasRenderingContext2D, f: RoomFurniture) {
    // Chairs first (behind the table), then the table top over the rug.
    this.drawChairs(cx, f);
    const inset = 7;
    this.roundRect(cx, f.x + inset, f.y + inset, f.w - inset * 2, f.h - inset * 2, 8);
    cx.fillStyle = PALETTE.tableTop;
    cx.fill();
    cx.strokeStyle = PALETTE.deskEdge;
    cx.lineWidth = 1;
    cx.stroke();
  }

  // Chairs along the table's long (top & bottom) sides, one per table column,
  // clamped to the room interior so they never land on a wall.
  private drawChairs(cx: CanvasRenderingContext2D, f: RoomFurniture) {
    const chair = 15;
    const gap = 5;
    const cols = Math.max(1, Math.round(f.w / TILE_SIZE));
    cx.fillStyle = PALETTE.chair;
    for (let i = 0; i < cols; i++) {
      const cxp = f.x + (i + 0.5) * (f.w / cols);
      const topY = f.y - gap - chair;
      if (topY >= f.iy) {
        this.roundRect(cx, cxp - chair / 2, topY, chair, chair, 4);
        cx.fill();
      }
      const botY = f.y + f.h + gap;
      if (botY + chair <= f.iy + f.ih) {
        this.roundRect(cx, cxp - chair / 2, botY, chair, chair, 4);
        cx.fill();
      }
    }
  }

  // Light oak plank floor: a warm base plus faint, world-aligned horizontal plank
  // seams (so they run continuously across tile boundaries).
  private drawWoodFloor(cx: CanvasRenderingContext2D, tx: number, ty: number) {
    const S = TILE_SIZE;
    cx.fillStyle = PALETTE.floorWood;
    cx.fillRect(tx, ty, S, S);
    cx.strokeStyle = PALETTE.floorWoodSeam;
    cx.lineWidth = 1;
    for (let y = Math.ceil(ty / 25) * 25; y < ty + S; y += 25) {
      cx.beginPath();
      cx.moveTo(tx, y + 0.5);
      cx.lineTo(tx + S, y + 0.5);
      cx.stroke();
    }
  }

  // Meeting-room cream rug: a flat, calm fill with a faint inset edge so the room
  // floor reads as a soft rug rather than the same plane as the open office.
  private drawRugFloor(cx: CanvasRenderingContext2D, tx: number, ty: number) {
    const S = TILE_SIZE;
    cx.fillStyle = PALETTE.floorRug;
    cx.fillRect(tx, ty, S, S);
  }

  // Warm off-white wall: a light base with a soft top highlight, a subtle bottom
  // shadow, and a faint seam — a clean partition, not the old near-black block.
  private drawWall(cx: CanvasRenderingContext2D, tx: number, ty: number) {
    const S = TILE_SIZE;
    cx.fillStyle = PALETTE.wall;
    cx.fillRect(tx, ty, S, S);
    cx.fillStyle = PALETTE.wallHi;
    cx.fillRect(tx, ty, S, 2);
    cx.fillStyle = PALETTE.wallShadow;
    cx.fillRect(tx, ty + S - 3, S, 3);
    cx.strokeStyle = PALETTE.wallSeam;
    cx.lineWidth = 1;
    cx.strokeRect(tx + 0.5, ty + 0.5, S - 1, S - 1);
  }

  // Open-office workstation: a rounded off-white desk top on the floor, a dark
  // monitor with a soft screen, and a hint of a keyboard.
  private drawWorkstation(cx: CanvasRenderingContext2D, tx: number, ty: number) {
    const S = TILE_SIZE;
    const pad = 5;
    this.roundRect(cx, tx + pad, ty + pad, S - pad * 2, S - pad * 2, 6);
    cx.fillStyle = PALETTE.deskTop;
    cx.fill();
    cx.strokeStyle = PALETTE.deskEdge;
    cx.lineWidth = 1;
    cx.stroke();
    // Monitor
    const mw = S * 0.44;
    const mh = S * 0.26;
    const mx = tx + S / 2 - mw / 2;
    const my = ty + pad + 3;
    cx.fillStyle = PALETTE.monitor;
    cx.fillRect(mx, my, mw, mh);
    cx.fillStyle = PALETTE.monitorScreen;
    cx.fillRect(mx + 2, my + 2, mw - 4, mh - 4);
    // Keyboard hint
    cx.fillStyle = PALETTE.deskEdge;
    cx.fillRect(tx + S / 2 - S * 0.2, ty + S - pad - S * 0.16, S * 0.4, S * 0.09);
  }

  // A chair just in front of (below) an open-office desk — the monitor faces up,
  // so the seat sits on the south side. Same sage rounded seat as the meeting
  // chairs, for consistency.
  private drawDeskChair(cx: CanvasRenderingContext2D, tx: number, ty: number) {
    const S = TILE_SIZE;
    const chair = 15;
    cx.fillStyle = PALETTE.chair;
    this.roundRect(cx, tx + S / 2 - chair / 2, ty + S - 6, chair, chair, 4);
    cx.fill();
  }

  // Sage plant in a terracotta pot: a small trapezoid pot with a cluster of
  // rounded leaves — a bit of greenery without pixel-art clutter.
  private drawPlant(cx: CanvasRenderingContext2D, tx: number, ty: number) {
    const S = TILE_SIZE;
    const cx0 = tx + S / 2;
    // Pot
    const potTop = ty + S * 0.62;
    const potH = S * 0.24;
    const potW = S * 0.34;
    cx.fillStyle = PALETTE.pot;
    cx.beginPath();
    cx.moveTo(cx0 - potW / 2, potTop);
    cx.lineTo(cx0 + potW / 2, potTop);
    cx.lineTo(cx0 + potW * 0.36, potTop + potH);
    cx.lineTo(cx0 - potW * 0.36, potTop + potH);
    cx.closePath();
    cx.fill();
    cx.fillStyle = PALETTE.potShade;
    cx.fillRect(cx0 - potW / 2, potTop, potW, 3);
    // Foliage
    cx.fillStyle = PALETTE.leaf;
    this.circle(cx, cx0, ty + S * 0.4, S * 0.2);
    this.circle(cx, cx0 - S * 0.15, ty + S * 0.5, S * 0.15);
    this.circle(cx, cx0 + S * 0.15, ty + S * 0.5, S * 0.15);
    cx.fillStyle = PALETTE.leafDark;
    this.circle(cx, cx0, ty + S * 0.5, S * 0.12);
  }

  private circle(cx: CanvasRenderingContext2D, x: number, y: number, r: number) {
    cx.beginPath();
    cx.arc(x, y, r, 0, Math.PI * 2);
    cx.fill();
  }

  private drawZone(
    ctx: CanvasRenderingContext2D,
    zone: { name: string; x: number; y: number; w: number; h: number },
    active: boolean,
  ) {
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

    // Feet planting point for the sprite. No foot decoration (shadow / self ring
    // / speaking ring) is drawn here — removed by request as visual clutter.
    const footY = p.y + PLAYER_RADIUS + 2;

    // Composited avatar sprite (#141). Falls back to the original colored circle
    // + initials until the sprite layers load.
    const drewSprite = this.characters.draw(
      ctx,
      p.outfit,
      p.facing,
      p.walkCol(),
      p.x,
      footY,
      SPRITE_SCALE,
    );
    if (!drewSprite) {
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
    }

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

    // name label. Set alignment explicitly: the background rect is centered on
    // p.x, but ctx.textAlign/textBaseline carry over from earlier draws (default
    // 'start'/'alphabetic' when a sprite is drawn and no status badge ran), which
    // would shift the text off the rect.
    ctx.font = '12px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
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
