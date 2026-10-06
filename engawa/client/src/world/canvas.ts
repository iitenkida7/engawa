import type { Point } from '@/core/proximity';
import {
  CONNECT_RADIUS,
  MAP_HEIGHT,
  MAP_WIDTH,
  PLAYER_RADIUS,
  REACTION_LIFETIME_MS,
  ZOOM_DEFAULT,
  ZOOM_MAX,
  ZOOM_MIN,
  ZOOM_PINCH_GAIN,
  ZOOM_WHEEL_GAIN,
} from '@/core/types';
import { CharacterSheet } from '@/world/character';
import { floorKindAt, propFor, type RoomKind, roomKindAt } from '@/world/decor';
import type { PlayerState } from '@/world/player';
import {
  deskFacesSouth,
  LOUNGE_RECT,
  MAP_COLS,
  MAP_ROWS,
  MEETING_ROOM_RECTS,
  officeMap,
  POD_RUGS,
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
  deskTopHi: '#ffffff',
  deskEdge: '#d8c6a4',
  monitor: '#3b414c',
  monitorScreen: '#6f93a3',
  screenGlow: '#a3c3d1',
  keyboard: '#e2e6e0',
  mouse: '#cfd3cd',
  tableTop: '#f4efe6', // meeting-table surface (warm off-white)
  tableTopHi: '#fbf7ef', // lighter top of the surface gradient
  tableEdge2: '#cdbb96', // table side/thickness (darker wood)
  tableGrain: 'rgba(170,150,110,0.16)',
  tableHi: 'rgba(255,255,255,0.4)',
  chair: '#8f9c8a', // sage-gray chairs around meeting tables
  chairBack: '#76836f', // chair backrest (a touch darker)
  pot: '#c98a5e',
  potShade: '#b2764a',
  leaf: '#7d9b6a',
  leafDark: '#688457',
  border: '#cabfa8',
  // Lounge (placeholder styling): a warm sage rug with soft seating, distinct
  // from the oak open office and the cream meeting rooms.
  loungeRug: '#dfe7d8',
  loungeRugEdge: 'rgba(125,155,106,0.5)',
  sofa: '#9aa7b8',
  sofaShade: '#7f8da0',
  sofaBack: '#78879b',
  sofaArm: '#8b98aa',
  sofaHi: '#b2bdcb',
  coffeeTable: '#a9774f',
  coffeeTableTop: '#c79b70',
  coffeeTableHi: '#dcbb95',
  // Faint tile grid drawn on every floor, and a soft shadow under furniture, for
  // a tidy "game floor" look with a little depth.
  floorGrid: 'rgba(90,75,50,0.07)',
  floorStripe: 'rgba(70,95,75,0.13)',
  floorCheck: 'rgba(120,95,140,0.14)',
  floorCheckBlue: 'rgba(85,120,165,0.12)',
  floorStripeV: 'rgba(230,155,190,0.16)',
  brickMortar: 'rgba(150,120,80,0.22)',
  shadow: 'rgba(40,35,25,0.14)',
  // Team-island rug (accent under desk pods) and window glass on outer walls.
  podRug: '#ece1c8',
  podRugEdge: 'rgba(150,130,95,0.45)',
  windowFrame: '#b9ad92',
  windowGlass: '#cfe3ec',
  windowGlint: 'rgba(255,255,255,0.55)',
  // Meeting-room props: a wall whiteboard and a filing cabinet.
  boardFrame: '#9aa2ad',
  boardFace: '#fbfdff',
  boardTray: '#cfd4db',
  marker1: '#5a8fd6',
  marker2: '#d66a6a',
  cabinet: '#b6bcc6',
  cabinetDark: '#9aa1ad',
  cabinetHandle: '#6f7784',
} as const;

// Per-room floor tints (Gather-like colour coding). Open office stays oak wood.
const ROOM_FLOOR: Record<RoomKind, string> = {
  exec: '#f8e9f0', // president's office — pale pink
  meeting: '#dce7f1', // meeting / all-hands — soft blue
  oneonone: '#dde9d7', // 1-on-1 — soft green
  booth: '#e8ddee', // negotiation booths — soft lavender
  lounge: '#dfe7d8', // lounge — sage
};

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

/**
 * New zoom level after a wheel/pinch event, clamped to [ZOOM_MIN, ZOOM_MAX].
 * Pure (no DOM) so the gesture math is unit-testable. The step is exponential so
 * every notch is a uniform multiplicative change; scrolling toward the top of
 * the page (deltaY < 0) zooms in. `deltaMode === 1` means the wheel reports
 * lines (Firefox mouse wheel) rather than pixels, so we approximate px; a
 * trackpad pinch arrives as a ctrl+wheel with finer deltas and a higher gain.
 */
export function zoomFromWheel(
  current: number,
  deltaY: number,
  deltaMode: number,
  ctrlKey: boolean,
): number {
  const px = deltaMode === 1 ? deltaY * 16 : deltaY;
  const gain = ctrlKey ? ZOOM_PINCH_GAIN : ZOOM_WHEEL_GAIN;
  const next = current * Math.exp(-px * gain);
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, next));
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
  // Repeating houndstooth fill for the booth floors, built with the cache context.
  private houndPattern: CanvasPattern | null = null;

  // Zoom factor about the camera center. ZOOM_DEFAULT (1.0) is the 1:1 view;
  // smaller surveys more of the office, larger magnifies. Driven by the mouse
  // wheel / trackpad pinch (see setupZoom). The map cache is
  // viewport-independent, so zooming never invalidates it.
  private zoomLevel = ZOOM_DEFAULT;

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
    this.setupZoom();
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

  // Mouse wheel and trackpad pinch zoom the map about the camera center (self
  // stays centered, matching the +/- buttons this replaced). A trackpad pinch
  // arrives as a wheel event with ctrlKey set; a mouse wheel or two-finger
  // scroll as a plain wheel — both zoom (map-app style). preventDefault stops
  // the page from scrolling, so the listener must be non-passive.
  private setupZoom() {
    this.canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.zoomLevel = zoomFromWheel(this.zoomLevel, e.deltaY, e.deltaMode, e.ctrlKey);
      },
      { passive: false },
    );
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
    this.houndPattern = this.buildHoundstooth(cx);

    // Pass 1 — floors + walls: rooms/lounge get a colour-coded rug, the open
    // office oak; walls get a window where they face the open floor.
    for (let r = 0; r < MAP_ROWS; r++) {
      for (let c = 0; c < MAP_COLS; c++) {
        const tx = c * TILE_SIZE;
        const ty = r * TILE_SIZE;
        if (officeMap[r][c] === Tile.WALL) {
          this.drawWall(cx, tx, ty, c, r);
          continue;
        }
        const roomKind = roomKindAt(c, r);
        const pattern =
          roomKind === 'oneonone'
            ? 'stripe'
            : roomKind === 'booth'
              ? 'houndstooth'
              : roomKind === 'meeting'
                ? 'checker'
                : roomKind === 'exec'
                  ? 'vstripe'
                  : roomKind === 'lounge'
                    ? 'brick'
                    : 'none';
        this.drawFloorTile(
          cx,
          tx,
          ty,
          roomKind ? ROOM_FLOOR[roomKind] : PALETTE.floorWood,
          pattern,
        );
      }
    }

    // Team-island rugs under the desk pods (over the floor, under the desks).
    for (const rug of POD_RUGS) this.drawPodRug(cx, rug);

    // Pass 2 — props: open-office desks are workstations; in-room desks are drawn
    // as designed tables/chairs by the furniture pass below, so skip them here.
    for (let r = 0; r < MAP_ROWS; r++) {
      for (let c = 0; c < MAP_COLS; c++) {
        const tile = officeMap[r][c];
        const tx = c * TILE_SIZE;
        const ty = r * TILE_SIZE;
        const prop = propFor(tile);
        if (prop === 'desk' && floorKindAt(c, r) === 'wood') {
          this.drawWorkstation(cx, tx, ty, deskFacesSouth(c, r));
        } else if (prop === 'plant') {
          this.drawPlant(cx, tx, ty);
        }
      }
    }

    // A chair in front of each open-office desk. Drawn in its own pass AFTER all
    // floors, because the seat sits just below the desk (extending into the next
    // tile) and would otherwise be painted over by that row's floor.
    for (let r = 0; r < MAP_ROWS; r++) {
      for (let c = 0; c < MAP_COLS; c++) {
        if (officeMap[r][c] === Tile.DESK && floorKindAt(c, r) === 'wood') {
          this.drawDeskChair(cx, c * TILE_SIZE, r * TILE_SIZE, deskFacesSouth(c, r));
        }
      }
    }

    // Meeting-room furniture: proper tables with chairs (and an exec desk for the
    // president's office), drawn over the rug once the tiles are laid down.
    for (const f of ROOM_FURNITURE) this.drawRoomFurniture(cx, f);

    // Lounge: sofas around a round coffee table, over the sage rug.
    this.drawLounge(cx, LOUNGE_RECT);

    // Meeting-room props: a wall whiteboard and a corner filing cabinet.
    for (const rect of MEETING_ROOM_RECTS) {
      this.drawWhiteboard(cx, rect);
      // The wide all-hands room has corner plants, so nudge its cabinet one tile
      // right of the corner plant; small rooms keep it in the corner.
      this.drawCabinet(cx, rect, rect.w > 5 * TILE_SIZE ? TILE_SIZE : 0);
    }

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
    // Chairs first (behind the table), then the table over the rug.
    this.drawChairs(cx, f);
    const inset = 7;
    const x = f.x + inset;
    const y = f.y + inset;
    const w = f.w - inset * 2;
    const h = f.h - inset * 2;
    const r = 9;
    // Drop shadow under the whole table.
    this.softShadow(cx, f.x + f.w / 2, y + h + 2, w / 2, 8);
    // Table side/thickness: a darker rounded slab offset down a few px.
    this.roundRect(cx, x, y + 3, w, h, r);
    cx.fillStyle = PALETTE.tableEdge2;
    cx.fill();
    // Top surface with a soft top-to-bottom gradient (a hint of sheen).
    const g = cx.createLinearGradient(0, y, 0, y + h);
    g.addColorStop(0, PALETTE.tableTopHi);
    g.addColorStop(1, PALETTE.tableTop);
    this.roundRect(cx, x, y, w, h, r);
    cx.fillStyle = g;
    cx.fill();
    // Faint wood grain across the surface.
    cx.strokeStyle = PALETTE.tableGrain;
    cx.lineWidth = 1;
    for (let gy = y + 9; gy < y + h - 4; gy += 9) {
      cx.beginPath();
      cx.moveTo(x + 6, gy + 0.5);
      cx.lineTo(x + w - 6, gy + 0.5);
      cx.stroke();
    }
    // Inner top highlight, then the outer rim.
    cx.strokeStyle = PALETTE.tableHi;
    cx.lineWidth = 1.5;
    this.roundRect(cx, x + 1.5, y + 1.5, w - 3, h - 3, r - 1);
    cx.stroke();
    cx.strokeStyle = PALETTE.deskEdge;
    cx.lineWidth = 1;
    this.roundRect(cx, x, y, w, h, r);
    cx.stroke();
  }

  // Chairs along the table's long (top & bottom) sides, one per table column,
  // clamped to the room interior so they never land on a wall.
  private drawChairs(cx: CanvasRenderingContext2D, f: RoomFurniture) {
    const chair = 15;
    const gap = 5;
    const cols = Math.max(1, Math.round(f.w / TILE_SIZE));
    for (let i = 0; i < cols; i++) {
      const cxp = f.x + (i + 0.5) * (f.w / cols);
      const topY = f.y - gap - chair;
      // Backrest sits on the far side from the table (top chairs: top edge).
      if (topY >= f.iy) this.drawOfficeChair(cx, cxp, topY, chair, 'top');
      const botY = f.y + f.h + gap;
      if (botY + chair <= f.iy + f.ih) this.drawOfficeChair(cx, cxp, botY, chair, 'bottom');
    }
  }

  // A simple chair: a seat with a backrest bar on `back` side (the side away from
  // the table) and a soft shadow, so it reads as a chair rather than a square.
  private drawOfficeChair(
    cx: CanvasRenderingContext2D,
    cxp: number,
    top: number,
    size: number,
    back: 'top' | 'bottom',
  ) {
    const backH = size * 0.3;
    this.softShadow(cx, cxp, top + size + 1, size / 2, 3);
    // Backrest.
    cx.fillStyle = PALETTE.chairBack;
    const backY = back === 'top' ? top : top + size - backH;
    this.roundRect(cx, cxp - size / 2, backY, size, backH, 3);
    cx.fill();
    // Seat.
    cx.fillStyle = PALETTE.chair;
    const seatY = back === 'top' ? top + backH - 2 : top;
    this.roundRect(cx, cxp - size / 2 + 1, seatY, size - 2, size - backH + 2, 3);
    cx.fill();
  }

  // The lounge: a round coffee table with sofas on each side. Purely cosmetic
  // (the rug stays walkable), drawn over the sage lounge floor. Placeholder look.
  private drawLounge(
    cx: CanvasRenderingContext2D,
    f: { x: number; y: number; w: number; h: number },
  ) {
    const cxp = f.x + f.w / 2;
    const cyp = f.y + f.h / 2;

    // Rug outline to frame the area.
    this.roundRect(cx, f.x + 5, f.y + 5, f.w - 10, f.h - 10, 12);
    cx.strokeStyle = PALETTE.loungeRugEdge;
    cx.lineWidth = 2;
    cx.stroke();

    // Long, thin rectangular coffee table in the middle.
    const tw = f.w * 0.46;
    const th = f.h * 0.2;
    const tx = cxp - tw / 2;
    const ty = cyp - th / 2;

    // Sofas tucked right up to the table on all four sides, facing in: 2-seaters
    // left/right, 4-seaters top/bottom. Offset = half the table + half the sofa
    // thickness (9) + a small gap.
    const near = 9 + 14;
    this.drawCouch(cx, cxp - tw / 2 - near, cyp, 'right', 54);
    this.drawCouch(cx, cxp + tw / 2 + near, cyp, 'left', 54);
    this.drawCouch(cx, cxp, cyp - th / 2 - near, 'down', 150);
    this.drawCouch(cx, cxp, cyp + th / 2 + near, 'up', 150);

    // Table surface: thickness, lit top, rim.
    this.softShadow(cx, cxp, ty + th + 2, tw / 2, 6);
    this.roundRect(cx, tx, ty + 3, tw, th, 6); // side/thickness
    cx.fillStyle = PALETTE.coffeeTable;
    cx.fill();
    const tg = cx.createLinearGradient(0, ty, 0, ty + th);
    tg.addColorStop(0, PALETTE.coffeeTableHi);
    tg.addColorStop(1, PALETTE.coffeeTableTop);
    this.roundRect(cx, tx, ty, tw, th, 6);
    cx.fillStyle = tg;
    cx.fill();
    cx.strokeStyle = PALETTE.coffeeTable;
    cx.lineWidth = 1;
    this.roundRect(cx, tx, ty, tw, th, 6);
    cx.stroke();
  }

  // A couch centred at (cxc, cyc) facing toward the coffee table. `len` is its
  // long dimension (so 150 ≈ a 4-seater, 54 ≈ a 2-seater). Backrest on the far
  // side, arm caps at both ends, evenly-spaced seat cushions, and a soft shadow.
  private drawCouch(
    cx: CanvasRenderingContext2D,
    cxc: number,
    cyc: number,
    facing: 'left' | 'right' | 'up' | 'down',
    len: number,
  ) {
    const thick = 18;
    const backW = 6;
    const arm = 7;
    const horizontal = facing === 'up' || facing === 'down';
    const w = horizontal ? len : thick;
    const h = horizontal ? thick : len;
    const x = cxc - w / 2;
    const y = cyc - h / 2;
    this.softShadow(cx, cxc, y + h + 1, w / 2, 4);
    // Base.
    this.roundRect(cx, x, y, w, h, 6);
    cx.fillStyle = PALETTE.sofa;
    cx.fill();
    // Backrest on the far side from the table.
    cx.fillStyle = PALETTE.sofaBack;
    if (facing === 'right') this.roundRect(cx, x, y, backW, h, 5);
    else if (facing === 'left') this.roundRect(cx, x + w - backW, y, backW, h, 5);
    else if (facing === 'down') this.roundRect(cx, x, y, w, backW, 5);
    else this.roundRect(cx, x, y + h - backW, w, backW, 5);
    cx.fill();
    // Arm caps at the two ends.
    cx.fillStyle = PALETTE.sofaArm;
    if (horizontal) {
      this.roundRect(cx, x, y, arm, h, 5);
      cx.fill();
      this.roundRect(cx, x + w - arm, y, arm, h, 5);
      cx.fill();
    } else {
      this.roundRect(cx, x, y, w, arm, 5);
      cx.fill();
      this.roundRect(cx, x, y + h - arm, w, arm, 5);
      cx.fill();
    }
    // Evenly-spaced seat cushions along the long axis, on the seat side.
    const avail = len - arm * 2;
    const n = Math.max(2, Math.round(avail / 30));
    const step = avail / n;
    cx.fillStyle = PALETTE.sofaHi;
    for (let k = 0; k < n; k++) {
      if (horizontal) {
        const cxk = x + arm + k * step;
        const cyk = facing === 'down' ? y + backW + 1 : y + 1;
        this.roundRect(cx, cxk + 1, cyk, step - 2, thick - backW - 2, 3);
      } else {
        const cyk = y + arm + k * step;
        const cxk = facing === 'right' ? x + backW + 1 : x + 1;
        this.roundRect(cx, cxk, cyk + 1, thick - backW - 2, step - 2, 3);
      }
      cx.fill();
    }
  }

  // A wall-mounted whiteboard along the top interior edge of a meeting room, with
  // a frame, a pen tray, and a couple of marker scribbles.
  private drawWhiteboard(
    cx: CanvasRenderingContext2D,
    rect: { x: number; y: number; w: number; h: number },
  ) {
    const w = Math.min(rect.w - 20, 86);
    const h = 11;
    const x = rect.x + (rect.w - w) / 2;
    const y = rect.y + 3;
    cx.fillStyle = PALETTE.boardFrame;
    this.roundRect(cx, x - 2, y - 2, w + 4, h + 6, 2);
    cx.fill();
    cx.fillStyle = PALETTE.boardFace;
    cx.fillRect(x, y, w, h);
    cx.fillStyle = PALETTE.boardTray;
    cx.fillRect(x - 1, y + h, w + 2, 2);
    // Marker scribbles.
    cx.strokeStyle = PALETTE.marker1;
    cx.lineWidth = 1.5;
    cx.beginPath();
    cx.moveTo(x + 6, y + 4);
    cx.lineTo(x + w * 0.4, y + 4);
    cx.moveTo(x + 6, y + 7);
    cx.lineTo(x + w * 0.28, y + 7);
    cx.stroke();
    cx.strokeStyle = PALETTE.marker2;
    cx.beginPath();
    cx.moveTo(x + w * 0.55, y + 5);
    cx.lineTo(x + w - 6, y + 5);
    cx.stroke();
  }

  // A small filing cabinet in the bottom-left interior corner of a room: a body
  // with a few drawers and handles, plus a soft shadow.
  private drawCabinet(
    cx: CanvasRenderingContext2D,
    rect: { x: number; y: number; w: number; h: number },
    xShift = 0,
  ) {
    const cw = 16;
    const ch = 24;
    const x = rect.x + 4 + xShift;
    const y = rect.y + rect.h - ch - 4;
    this.softShadow(cx, x + cw / 2, y + ch + 1, cw / 2 + 1, 4);
    cx.fillStyle = PALETTE.cabinet;
    this.roundRect(cx, x, y, cw, ch, 2);
    cx.fill();
    // Drawers + handles.
    cx.strokeStyle = PALETTE.cabinetDark;
    cx.lineWidth = 1;
    cx.fillStyle = PALETTE.cabinetHandle;
    for (let i = 0; i < 3; i++) {
      const dy = y + 3 + i * ((ch - 4) / 3);
      cx.beginPath();
      cx.moveTo(x + 1, dy + (ch - 4) / 3 - 1);
      cx.lineTo(x + cw - 1, dy + (ch - 4) / 3 - 1);
      cx.stroke();
      cx.fillRect(x + cw / 2 - 3, dy + 2, 6, 2);
    }
  }

  // One floor tile: a flat colour fill plus a faint square grid (right + bottom
  // edge), so every floor reads as tidy game tiles regardless of room colour.
  private drawFloorTile(
    cx: CanvasRenderingContext2D,
    tx: number,
    ty: number,
    color: string,
    pattern: 'none' | 'stripe' | 'vstripe' | 'checker' | 'houndstooth' | 'brick' = 'none',
  ) {
    const S = TILE_SIZE;
    cx.fillStyle = color;
    cx.fillRect(tx, ty, S, S);
    // Patterns are world-aligned so they run continuously across tile boundaries.
    if (pattern === 'stripe') {
      // Horizontal stripes (2px line every 14px) — the 1-on-1 rooms.
      cx.fillStyle = PALETTE.floorStripe;
      for (let y = Math.ceil(ty / 14) * 14; y < ty + S; y += 14) {
        cx.fillRect(tx, y, S, 2);
      }
    } else if (pattern === 'vstripe') {
      // Thin vertical bands (8px on / 8px off), world-aligned — president's office.
      const band = 8;
      const period = band * 2;
      cx.fillStyle = PALETTE.floorStripeV;
      for (let gx = Math.floor(tx / period) * period; gx < tx + S; gx += period) {
        const x0 = Math.max(gx, tx);
        const x1 = Math.min(gx + band, tx + S);
        if (x1 > x0) cx.fillRect(x0, ty, x1 - x0, S);
      }
    } else if (pattern === 'checker') {
      // Checkerboard (10px cells) — the meeting rooms.
      const CS = 10;
      cx.fillStyle = PALETTE.floorCheckBlue;
      for (let gx = Math.floor(tx / CS) * CS; gx < tx + S; gx += CS) {
        for (let gy = Math.floor(ty / CS) * CS; gy < ty + S; gy += CS) {
          if ((gx / CS + gy / CS) % 2 === 0) cx.fillRect(gx, gy, CS, CS);
        }
      }
    } else if (pattern === 'brick') {
      // Running-bond brick: horizontal mortar lines, and vertical mortar offset
      // half a brick every other row. World-aligned so it tiles seamlessly.
      const BH = 16;
      const BW = 46;
      cx.fillStyle = PALETTE.brickMortar;
      for (let y = Math.floor(ty / BH) * BH; y < ty + S; y += BH) {
        if (y >= ty) cx.fillRect(tx, y, S, 2); // horizontal mortar
        const off = (Math.floor(y / BH) % 2) * (BW / 2);
        const y0 = Math.max(y, ty);
        const y1 = Math.min(y + BH, ty + S);
        for (let x = Math.ceil((tx - off) / BW) * BW + off; x < tx + S; x += BW) {
          if (x >= tx && y1 > y0) cx.fillRect(x, y0, 2, y1 - y0); // vertical mortar
        }
      }
    } else if (pattern === 'houndstooth' && this.houndPattern) {
      // Houndstooth weave — the negotiation booths. Pattern is anchored to the
      // world origin, so it tiles seamlessly across adjacent booth tiles.
      cx.fillStyle = this.houndPattern;
      cx.fillRect(tx, ty, S, S);
    }
    cx.strokeStyle = PALETTE.floorGrid;
    cx.lineWidth = 1;
    cx.beginPath();
    cx.moveTo(tx + S - 0.5, ty);
    cx.lineTo(tx + S - 0.5, ty + S);
    cx.moveTo(tx, ty + S - 0.5);
    cx.lineTo(tx + S, ty + S - 0.5);
    cx.stroke();
  }

  // Build a repeating houndstooth (千鳥格子) tile in the booth accent colour. A
  // 4×4 broken-twill mask tiled over the floor gives the classic woven look.
  private buildHoundstooth(cx: CanvasRenderingContext2D): CanvasPattern | null {
    const u = 7; // cell size (px)
    const n = 4;
    const p = document.createElement('canvas');
    p.width = u * n;
    p.height = u * n;
    const g = p.getContext('2d');
    if (!g) return null;
    g.fillStyle = PALETTE.floorCheck;
    const mask = [
      [1, 1, 0, 1],
      [1, 1, 1, 0],
      [0, 1, 1, 1],
      [1, 0, 1, 1],
    ];
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        if (mask[y][x]) g.fillRect(x * u, y * u, u, u);
      }
    }
    return cx.createPattern(p, 'repeat');
  }

  // Soft elliptical shadow on the floor under a prop, for a little depth.
  private softShadow(cx: CanvasRenderingContext2D, x: number, y: number, rx: number, ry: number) {
    cx.fillStyle = PALETTE.shadow;
    cx.beginPath();
    cx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
    cx.fill();
  }

  // Soft accent rug under a desk pod, so team islands read as neighbourhoods.
  private drawPodRug(
    cx: CanvasRenderingContext2D,
    f: { x: number; y: number; w: number; h: number },
  ) {
    this.roundRect(cx, f.x, f.y, f.w, f.h, 10);
    cx.fillStyle = PALETTE.podRug;
    cx.fill();
    cx.strokeStyle = PALETTE.podRugEdge;
    cx.lineWidth = 1.5;
    cx.stroke();
    // Inset second border line, for a tidy framed-rug look.
    const i = 5;
    this.roundRect(cx, f.x + i, f.y + i, f.w - i * 2, f.h - i * 2, 7);
    cx.lineWidth = 1;
    cx.stroke();
  }

  // Warm off-white wall: a light base with a soft top highlight, a subtle bottom
  // shadow, and a faint seam — a clean partition, not the old near-black block.
  // Outer side walls facing the open office (every other row) get a window.
  private drawWall(cx: CanvasRenderingContext2D, tx: number, ty: number, col: number, row: number) {
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

    // Windows: left/right outer walls along the open-office rows, every other tile.
    const onSideWall = col === 0 || col === MAP_COLS - 1;
    if (onSideWall && row >= 7 && row <= 17 && row % 2 === 1) {
      const m = 9; // inset from the tile edge
      cx.fillStyle = PALETTE.windowFrame;
      this.roundRect(cx, tx + m - 2, ty + m - 2, S - (m - 2) * 2, S - (m - 2) * 2, 3);
      cx.fill();
      cx.fillStyle = PALETTE.windowGlass;
      this.roundRect(cx, tx + m, ty + m, S - m * 2, S - m * 2, 2);
      cx.fill();
      cx.strokeStyle = PALETTE.windowGlint;
      cx.lineWidth = 2;
      cx.beginPath();
      cx.moveTo(tx + m + 3, ty + S - m - 4);
      cx.lineTo(tx + S - m - 4, ty + m + 3);
      cx.stroke();
    }
  }

  // Open-office workstation: a rounded off-white desk top on the floor, a dark
  // monitor with a soft screen, and a hint of a keyboard. `facesSouth` flips it
  // vertically (monitor at the bottom, keyboard at the top) so the occupant sits
  // above, facing down — used for the upper row of a facing pod.
  private drawWorkstation(
    cx: CanvasRenderingContext2D,
    tx: number,
    ty: number,
    facesSouth = false,
  ) {
    const S = TILE_SIZE;
    const pad = 5;
    const cxm = tx + S / 2;
    this.softShadow(cx, cxm, ty + S - pad + 1, S / 2 - pad + 1, 5);
    // Desk: thickness slab, then a gradient top and rim.
    this.roundRect(cx, tx + pad, ty + pad + 2, S - pad * 2, S - pad * 2, 6);
    cx.fillStyle = PALETTE.deskEdge;
    cx.fill();
    const dg = cx.createLinearGradient(0, ty + pad, 0, ty + S - pad);
    dg.addColorStop(0, PALETTE.deskTopHi);
    dg.addColorStop(1, PALETTE.deskTop);
    this.roundRect(cx, tx + pad, ty + pad, S - pad * 2, S - pad * 2, 6);
    cx.fillStyle = dg;
    cx.fill();
    cx.strokeStyle = PALETTE.deskEdge;
    cx.lineWidth = 1;
    cx.stroke();

    // Monitor (screen + stand) near the far edge; keyboard + mouse on the seat
    // side (top when the desk is flipped to face south).
    const mw = S * 0.4;
    const mh = S * 0.2;
    const mx = cxm - mw / 2;
    const my = facesSouth ? ty + S - pad - 3 - mh : ty + pad + 3;
    // Stand: a neck and base on the seat side of the screen.
    cx.fillStyle = PALETTE.monitor;
    cx.fillRect(cxm - 1.5, facesSouth ? my - 4 : my + mh, 3, 4);
    cx.fillRect(cxm - 5, facesSouth ? my - 6 : my + mh + 4, 10, 2);
    // Screen with a soft glow.
    this.roundRect(cx, mx, my, mw, mh, 2);
    cx.fillStyle = PALETTE.monitor;
    cx.fill();
    const sg = cx.createLinearGradient(0, my, 0, my + mh);
    sg.addColorStop(0, PALETTE.screenGlow);
    sg.addColorStop(1, PALETTE.monitorScreen);
    cx.fillStyle = sg;
    cx.fillRect(mx + 2, my + 2, mw - 4, mh - 4);
    // Keyboard + mouse on the seat side.
    const ky = facesSouth ? ty + pad + 4 : ty + S - pad - 10;
    cx.fillStyle = PALETTE.keyboard;
    this.roundRect(cx, cxm - S * 0.22, ky, S * 0.34, 6, 2);
    cx.fill();
    cx.fillStyle = PALETTE.mouse;
    this.roundRect(cx, cxm + S * 0.16, ky + 1, 4, 5, 2);
    cx.fill();
  }

  // A chair just in front of an open-office desk. Default: below the desk (the
  // occupant faces up). `facesSouth` puts it above the desk (occupant faces
  // down). Same sage rounded seat as the meeting chairs, for consistency.
  private drawDeskChair(cx: CanvasRenderingContext2D, tx: number, ty: number, facesSouth = false) {
    const S = TILE_SIZE;
    const size = 16;
    const top = facesSouth ? ty - size + 6 : ty + S - 6;
    this.drawOfficeChair(cx, tx + S / 2, top, size, facesSouth ? 'top' : 'bottom');
  }

  // Sage plant in a terracotta pot: a small trapezoid pot with a cluster of
  // rounded leaves — a bit of greenery without pixel-art clutter.
  private drawPlant(cx: CanvasRenderingContext2D, tx: number, ty: number) {
    const S = TILE_SIZE;
    const cx0 = tx + S / 2;
    this.softShadow(cx, cx0, ty + S * 0.86, S * 0.26, S * 0.08);
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
