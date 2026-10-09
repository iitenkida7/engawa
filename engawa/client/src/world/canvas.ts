import { t } from '@/core/i18n';
import type { Point } from '@/core/proximity';
import {
  CONNECT_RADIUS,
  MAP_HEIGHT,
  MAP_WIDTH,
  PLAYER_RADIUS,
  REACTION_LIFETIME_MS,
  SEAT_CONNECT_RADIUS,
  ZOOM_DEFAULT,
  ZOOM_MAX,
  ZOOM_MIN,
  ZOOM_PINCH_GAIN,
  ZOOM_WHEEL_GAIN,
} from '@/core/types';
import { STATUS_EMOJI } from '@/ui/status-menu';
import { CharacterSheet } from '@/world/character';
import { floorKindAt, propFor } from '@/world/decor';
import type { PlayerState } from '@/world/player';
import {
  deskFacesSouth,
  type FloorPattern,
  type FloorStyle,
  floorStyleAt,
  isDeskSeat,
  islandFloorStyle,
  LOUNGE_RECTS,
  LOUNGE_TABLE_RECTS,
  MAP_COLS,
  MAP_ROWS,
  MEETING_ROOM_RECTS,
  OPEN_DESK_CHAIRS,
  officeMap,
  POD_RUGS,
  ROOM_FURNITURE,
  type RoomFurniture,
  TILE_SIZE,
  Tile,
  TREES,
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
  // Outdoor grounds (#229): grass lawn and trees around the building.
  grass: '#dcebcd',
  grassSeam: 'rgba(150,180,125,0.12)',
  grassTuft: 'rgba(160,190,135,0.4)',
  treeTrunk: '#8a6a43',
  treeCanopy: '#6fa052',
  treeCanopyHi: '#8bbd68',
  treeCanopyShade: '#577f41',
  // Second tree tint for variety: a distinctly darker, richer green.
  treeCanopy2: '#3f7a3c',
  treeCanopyHi2: '#57984e',
  treeCanopyShade2: '#2d5c2b',
  // Faint tile grid drawn on every floor, and a soft shadow under furniture, for
  // a tidy "game floor" look with a little depth.
  floorGrid: 'rgba(90,75,50,0.07)',
  floorStripe: 'rgba(70,95,75,0.13)',
  floorCheck: 'rgba(120,95,140,0.14)',
  floorCheckBlue: 'rgba(85,120,165,0.12)',
  floorStripeV: 'rgba(230,155,190,0.16)',
  brickMortar: 'rgba(150,120,80,0.22)',
  // Café floors (#263 follow-up): crosshatch = a soft diagonal net over the café's
  // sage base; herringbone = warm wood planks with soft grooves.
  crosshatchLine: 'rgba(90,110,80,0.28)',
  chevronLine: 'rgba(120,95,140,0.3)',
  herringWood: '#d9c29a',
  herringWoodAlt: '#cdb488',
  herringMortar: 'rgba(120,88,52,0.38)',
  shadow: 'rgba(40,35,25,0.14)',
  // Team-island rug (accent under desk pods).
  podRug: '#ece1c8',
  podRugEdge: 'rgba(150,130,95,0.45)',
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

// (Rooms/cafés/islands no longer colour-code by kind; they use FLOOR_THEMES.)
// Rug colour themes (#263 follow-up): a pale base fill + a matching accent for
// the pattern marks. Rooms/cafés/islands pick one by index (tilemap FloorStyle),
// so the floors are varied instead of colour-coded by kind. Order is the colour
// index; keep the length == FLOOR_COLOR_COUNT.
const FLOOR_THEMES: { base: string; accent: string }[] = [
  // Muted, greyed mid-tones (calm, not colourful) — matched to the slate feel.
  { base: '#b4c2a8', accent: 'rgba(84,106,78,0.32)' }, // green — greyed sage
  { base: '#b2c0d4', accent: 'rgba(74,100,138,0.32)' }, // blue — greyed
  { base: '#c3bcce', accent: 'rgba(104,92,134,0.3)' }, // lavender — greyed mauve
  { base: '#d2bcc3', accent: 'rgba(158,108,126,0.3)' }, // pink — greyed rose
  { base: '#cdc4a6', accent: 'rgba(138,120,72,0.32)' }, // amber — greyed ochre
  { base: '#d7e4df', accent: 'rgba(88,140,130,0.26)' }, // teal — pale, whitish
  { base: '#d1b8ab', accent: 'rgba(158,104,78,0.3)' }, // terracotta — greyed clay
  { base: '#bcc4d6', accent: 'rgba(84,100,132,0.32)' }, // slate
  // Index 8 (CAFE_COLOR): reserved dusty-red theme for the cafés.
  { base: '#d2a7a2', accent: 'rgba(168,74,68,0.32)' }, // café red — muted brick red
];

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
  // Floor-pattern cache, keyed by `${pattern}|${accent}` so each colour variant is
  // built once and reused across tiles.
  private patternCache = new Map<string, CanvasPattern | null>();

  // Zoom factor about the camera center. ZOOM_DEFAULT (1.0) is the 1:1 view;
  // smaller surveys more of the office, larger magnifies. Driven by the mouse
  // wheel / trackpad pinch (see setupZoom). The map cache is
  // viewport-independent, so zooming never invalidates it.
  private zoomLevel = ZOOM_DEFAULT;
  // Target the zoom eases toward each frame, so the one-button zoom controls
  // animate smoothly (#231) instead of snapping. Wheel/pinch set it in lockstep
  // with zoomLevel so they stay instant.
  private zoomTarget = ZOOM_DEFAULT;

  // Camera center (world px). While `following` (the default) it tracks self each
  // frame; dragging the map turns following off and pans camX/camY freely
  // (clamped to the map), and any self-movement re-centers (recenter()).
  private camX = MAP_WIDTH / 2;
  private camY = MAP_HEIGHT / 2;
  private following = true;
  // When set (by zoomToFit), the camera eases toward this point while not
  // following; cleared on drag / recenter so the user stays in control.
  private camTargetX = MAP_WIDTH / 2;
  private camTargetY = MAP_HEIGHT / 2;
  private camAnimating = false;
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
      this.camAnimating = false;
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
    this.camAnimating = false;
  }

  // One-button "zoom to me": ease back to the 1:1 view centered on self (#231).
  zoomToSelf() {
    this.zoomTarget = ZOOM_DEFAULT;
    this.following = true;
    this.camAnimating = false;
  }

  // One-button "see everything": ease out to fit the whole map and glide the
  // camera to its center (stops following until you move or zoom to self) (#231).
  zoomToFit() {
    const fit = Math.min(this.viewW / MAP_WIDTH, this.viewH / MAP_HEIGHT);
    // Small margin so the grounds aren't flush to the edges. This can go below the
    // wheel's ZOOM_MIN (the whole map must fit); a wheel tick snaps back into range.
    this.zoomTarget = Math.max(0.2, fit * 0.95);
    this.following = false;
    this.camTargetX = MAP_WIDTH / 2;
    this.camTargetY = MAP_HEIGHT / 2;
    this.camAnimating = true;
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
        // Keep the eased target in lockstep so wheel/pinch stay instant and don't
        // fight the one-button zoom animation (#231).
        this.zoomTarget = this.zoomLevel;
        this.camAnimating = false;
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

    // Ease the zoom toward its target each frame so the one-button controls
    // animate like a pinch (#231). ~0.2/frame ≈ a ~200ms glide; snap when close.
    if (Math.abs(this.zoomLevel - this.zoomTarget) > 0.0005) {
      this.zoomLevel += (this.zoomTarget - this.zoomLevel) * 0.2;
    } else {
      this.zoomLevel = this.zoomTarget;
    }
    // Camera: while following, track self (or the map center before join); while
    // panning, camX/camY are driven by the drag. Zoom is about the camera center.
    const zoom = this.zoomLevel;
    if (this.following) {
      this.camX = self ? self.x : MAP_WIDTH / 2;
      this.camY = self ? self.y : MAP_HEIGHT / 2;
    } else if (this.camAnimating) {
      // Glide the camera to the fit target, then stop animating.
      this.camX += (this.camTargetX - this.camX) * 0.2;
      this.camY += (this.camTargetY - this.camY) * 0.2;
      if (
        Math.abs(this.camX - this.camTargetX) < 0.5 &&
        Math.abs(this.camY - this.camTargetY) < 0.5
      ) {
        this.camX = this.camTargetX;
        this.camY = this.camTargetY;
        this.camAnimating = false;
      }
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
    // Rebuild when the device-pixel ratio changes OR the baked image no longer
    // matches the current map size — the latter guards against a stale cache
    // after the map dimensions change (e.g. a hot-reload that widened the outdoor
    // margin), which would otherwise leave the grass/border drawn to the old edge.
    const wantW = Math.round(MAP_WIDTH * dpr);
    if (!this.mapCache || this.mapCacheDpr !== dpr || this.mapCache.width !== wantW) {
      this.buildMapCache(dpr);
    }
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
      // A desk seat is private: the reach shrinks to just the adjacent tiles.
      const reach = isDeskSeat(self.x, self.y) ? SEAT_CONNECT_RADIUS : CONNECT_RADIUS;
      ctx.beginPath();
      ctx.arc(self.x, self.y, reach, 0, Math.PI * 2);
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
    const selfAway = self?.status === 'away';
    const sortedPlayers = [...players].sort((a, b) => a.y - b.y);
    for (const p of sortedPlayers) {
      // While away (#220) our own avatar is hidden; we only spectate others.
      if (p.isSelf && selfAway) continue;
      this.drawPlayer(ctx, p, p.userId === highlightId);
    }

    // Floating emoji reactions, on top of the avatars they belong to.
    this.drawReactions(ctx, sortedPlayers);

    ctx.restore();

    // Away overlay (#220): a faint veil plus a small badge, drawn in screen space
    // on top of everything so it reads as "you've stepped away" without hiding
    // the room — others still move underneath. Away takes priority over the
    // zone-focus veil (#223), which dims everything outside the room you're in.
    if (selfAway) this.drawAwayOverlay(ctx, w, h);
    else if (selfZone) this.drawZoneFocusOverlay(ctx, w, h, selfZone);

    // Name labels last, in screen space at a constant size (#227), so you can
    // read who is where even zoomed out — and on top of the veil above.
    this.drawNameLabels(ctx, sortedPlayers, w, h, selfAway);
  }

  // Draw every player's name label in SCREEN space at a fixed size, so labels
  // stay readable at any zoom (unlike the world-space room labels, which scale).
  // Positions are projected from world→screen; overlapping labels are nudged
  // downward so a cluster stays legible (#227).
  private drawNameLabels(
    ctx: CanvasRenderingContext2D,
    players: PlayerState[],
    w: number,
    h: number,
    selfAway: boolean,
  ) {
    const zoom = this.zoomLevel;
    ctx.save();
    ctx.font = '14px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    const lh = 22;
    const gap = 2;
    const placed: { cx: number; top: number; lw: number }[] = [];
    const toDraw: { text: string; cx: number; top: number; lw: number; isSelf: boolean }[] = [];
    for (const p of players) {
      if (p.isSelf && selfAway) continue;
      // Project the avatar's head (world) to screen; the label sits just above it
      // with a constant pixel gap regardless of zoom.
      const sx = (p.x - this.camX) * zoom + w / 2;
      const headY = (p.y - PLAYER_RADIUS - this.camY) * zoom + h / 2;
      if (sx < -150 || sx > w + 150 || headY < -80 || headY > h + 80) continue;

      const text = `${STATUS_EMOJI[p.status]} ${p.name}${p.isSharingScreen ? '  🖥' : ''}`;
      const lw = ctx.measureText(text).width + 12;
      let top = headY - 6 - lh;

      // Nudge below any already-placed label it overlaps (both axes), so a cluster
      // reads as a vertical stack instead of a pile.
      for (const q of placed) {
        const overlapX = Math.abs(sx - q.cx) < (lw + q.lw) / 2;
        const overlapY = top < q.top + lh + gap && top + lh + gap > q.top;
        if (overlapX && overlapY) top = q.top + lh + gap;
      }
      placed.push({ cx: sx, top, lw });
      toDraw.push({ text, cx: sx, top, lw, isSelf: p.isSelf });
    }

    for (const l of toDraw) {
      // Tint our own label a solid indigo so "which one is me" reads at a glance.
      ctx.fillStyle = l.isSelf ? 'rgba(85,70,183,1)' : 'rgba(0,0,0,0.65)';
      this.roundRect(ctx, l.cx - l.lw / 2, l.top, l.lw, lh, 8);
      ctx.fill();
      ctx.fillStyle = 'white';
      ctx.fillText(l.text, l.cx, l.top + lh / 2 + 1);
    }
    ctx.restore();
  }

  // Zone-focus veil (#223): while inside a conversation zone, dim everything
  // outside its rectangle so the room reads as "where you are". Drawn in screen
  // space with an even-odd fill (viewport rect minus the zone's projected rect).
  private drawZoneFocusOverlay(
    ctx: CanvasRenderingContext2D,
    w: number,
    h: number,
    zone: { x: number; y: number; w: number; h: number },
  ) {
    const z = this.zoomLevel;
    const zx = (zone.x - this.camX) * z + w / 2;
    const zy = (zone.y - this.camY) * z + h / 2;
    ctx.save();
    ctx.fillStyle = 'rgba(16,20,28,0.3)';
    ctx.beginPath();
    ctx.rect(0, 0, w, h);
    ctx.rect(zx, zy, zone.w * z, zone.h * z);
    ctx.fill('evenodd');
    ctx.restore();
  }

  private drawAwayOverlay(ctx: CanvasRenderingContext2D, w: number, h: number) {
    ctx.save();
    ctx.fillStyle = 'rgba(20,24,33,0.28)';
    ctx.fillRect(0, 0, w, h);

    // Small pill, top-center.
    const label = t('status.awayOverlay');
    ctx.font = '13px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const tw = ctx.measureText(label).width;
    const padX = 14;
    const pw = tw + padX * 2;
    const ph = 30;
    const px = w / 2 - pw / 2;
    const py = 16;
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    this.roundRect(ctx, px, py, pw, ph, 15);
    ctx.fill();
    ctx.fillStyle = '#ffd27a';
    ctx.fillText(label, w / 2, py + ph / 2 + 1);
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
    this.patternCache.clear();

    // Pass 1 — floors + walls: rooms/lounge get a colour-coded rug, the open
    // office oak; walls get a window where they face the open floor.
    for (let r = 0; r < MAP_ROWS; r++) {
      for (let c = 0; c < MAP_COLS; c++) {
        const tx = c * TILE_SIZE;
        const ty = r * TILE_SIZE;
        const tile = officeMap[r][c];
        if (tile === Tile.WALL) {
          this.drawWall(cx, tx, ty, c, r);
          continue;
        }
        // Outdoor tiles (#229): grass base, with trees drawn on top in pass 2.
        if (tile === Tile.GRASS || tile === Tile.TREE) {
          this.drawGrassTile(cx, tx, ty, c, r);
          continue;
        }
        // Rooms + cafés get a randomised (pattern, colour) rug; open floor is oak.
        const style = floorStyleAt(c, r);
        if (style) {
          const theme = FLOOR_THEMES[style.color];
          this.drawFloorTile(cx, tx, ty, theme.base, style.pattern, theme.accent);
        } else {
          this.drawFloorTile(cx, tx, ty, PALETTE.floorWood, 'none');
        }
      }
    }

    // Team-island rugs under the desk pods (over the floor, under the desks),
    // each with its own randomised style.
    POD_RUGS.forEach((rug, i) => {
      this.drawPodRug(cx, rug, islandFloorStyle(i));
    });

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

    // One chair in front of each open-office desk island (centred on the 3-wide
    // desk). Drawn in its own pass AFTER all floors, because the seat sits just
    // in front of the desk (extending into the next tile) and would otherwise be
    // painted over by that row's floor.
    for (const ch of OPEN_DESK_CHAIRS) {
      this.drawDeskChair(cx, ch.col * TILE_SIZE, ch.row * TILE_SIZE, ch.facesSouth);
    }

    // Meeting-room furniture: proper tables with chairs (and an exec desk for the
    // president's office), drawn over the rug once the tiles are laid down.
    for (const f of ROOM_FURNITURE) this.drawRoomFurniture(cx, f);

    // Lounge: sofas around a round coffee table, over the sage rug.
    for (let i = 0; i < LOUNGE_RECTS.length; i++)
      this.drawLounge(cx, LOUNGE_RECTS[i], LOUNGE_TABLE_RECTS[i]);

    // Meeting-room props: a wall whiteboard and a corner filing cabinet.
    for (const rect of MEETING_ROOM_RECTS) {
      this.drawWhiteboard(cx, rect);
      // The wide all-hands room has corner plants, so nudge its cabinet one tile
      // right of the corner plant; small rooms keep it in the corner.
      this.drawCabinet(cx, rect, rect.w > 5 * TILE_SIZE ? TILE_SIZE : 0);
    }

    // Outdoor trees on the grounds (small 1×1 and big 2×2), drawn from the random
    // layout over the grass. Sorted by foot Y so nearer trees overlap farther ones.
    for (const tree of [...TREES].sort((a, b) => a.y - b.y)) {
      this.drawTree(cx, tree.x, tree.y, tree.tiles, tree.variant);
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
    table: { x: number; y: number; w: number; h: number },
  ) {
    const cxp = f.x + f.w / 2;
    const cyp = f.y + f.h / 2;

    // Rug outline to frame the area.
    this.roundRect(cx, f.x + 5, f.y + 5, f.w - 10, f.h - 10, 12);
    cx.strokeStyle = PALETTE.loungeRugEdge;
    cx.lineWidth = 2;
    cx.stroke();

    // Long, thin rectangular coffee table in the middle. Geometry is shared with
    // collision (LOUNGE_TABLE_RECTS) so the drawn table is exactly what blocks.
    const { x: tx, y: ty, w: tw, h: th } = table;

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
    pattern: FloorPattern = 'none',
    accent = 'rgba(0,0,0,0.12)',
  ) {
    const S = TILE_SIZE;
    cx.fillStyle = color;
    cx.fillRect(tx, ty, S, S);
    // The pattern is a world-origin-anchored CanvasPattern, so accent marks run
    // continuously across tile boundaries.
    if (pattern !== 'none') {
      const pat = this.getFloorPattern(cx, pattern, accent);
      if (pat) {
        cx.fillStyle = pat;
        cx.fillRect(tx, ty, S, S);
      }
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

  // Returns (building once, then cached) a repeating CanvasPattern of accent-
  // coloured marks for a floor pattern, so any pattern can be drawn in any colour.
  private getFloorPattern(
    cx: CanvasRenderingContext2D,
    pattern: FloorPattern,
    accent: string,
  ): CanvasPattern | null {
    const key = `${pattern}|${accent}`;
    const hit = this.patternCache.get(key);
    if (hit !== undefined) return hit;
    const pat = this.buildFloorPattern(cx, pattern, accent);
    this.patternCache.set(key, pat);
    return pat;
  }

  // Builds a repeating accent-coloured tile for one floor pattern. All marks are
  // drawn in `accent` over a transparent background, so the tile's base colour
  // shows through. Every tile is sized so its motif wraps seamlessly.
  private buildFloorPattern(
    cx: CanvasRenderingContext2D,
    pattern: FloorPattern,
    accent: string,
  ): CanvasPattern | null {
    const p = document.createElement('canvas');
    // Size per pattern. IMPORTANT: set width/height BEFORE any style/draw —
    // assigning a canvas's size resets its 2D context (fillStyle back to black).
    const sizes: Record<string, [number, number]> = {
      stripe: [14, 14],
      vstripe: [16, 16],
      checker: [20, 20],
      brick: [46, 32],
      houndstooth: [28, 28],
      crosshatch: [18, 18],
      herringbone: [48, 48],
      chevron: [24, 12],
    };
    const size = sizes[pattern];
    if (!size) return null;
    p.width = size[0];
    p.height = size[1];
    const g = p.getContext('2d');
    if (!g) return null;
    g.fillStyle = accent;
    g.strokeStyle = accent;
    switch (pattern) {
      case 'stripe': {
        // Horizontal stripes (2px line every 14px).
        g.fillRect(0, 0, 14, 2);
        break;
      }
      case 'vstripe': {
        // Vertical bands (8px on / 8px off).
        g.fillRect(0, 0, 8, 16);
        break;
      }
      case 'checker': {
        // Checkerboard (10px cells).
        g.fillRect(0, 0, 10, 10);
        g.fillRect(10, 10, 10, 10);
        break;
      }
      case 'brick': {
        // Running-bond: horizontal mortar every 16px, verticals offset per row.
        g.fillRect(0, 0, 46, 2);
        g.fillRect(0, 16, 46, 2);
        g.fillRect(0, 0, 2, 16); // top row vertical
        g.fillRect(23, 16, 2, 16); // bottom row vertical, offset half a brick
        break;
      }
      case 'houndstooth': {
        // 4×4 broken-twill weave (千鳥格子).
        const u = 7;
        const mask = [
          [1, 1, 0, 1],
          [1, 1, 1, 0],
          [0, 1, 1, 1],
          [1, 0, 1, 1],
        ];
        for (let y = 0; y < 4; y++)
          for (let x = 0; x < 4; x++) if (mask[y][x]) g.fillRect(x * u, y * u, u, u);
        break;
      }
      case 'crosshatch': {
        // Diagonal net: one ╲ and one ╱ per cell.
        const s = 18;
        g.lineWidth = 1.5;
        g.beginPath();
        g.moveTo(0, 0);
        g.lineTo(s, s);
        g.moveTo(0, s);
        g.lineTo(s, 0);
        g.stroke();
        break;
      }
      case 'herringbone': {
        // Diagonal plank grooves meeting in a V on the seam (48×48, spacing 12).
        const T = 48;
        const sp = 12;
        g.lineWidth = 1.5;
        g.save();
        g.beginPath();
        g.rect(0, 0, T / 2, T);
        g.clip();
        g.beginPath();
        for (let k = -T; k <= T; k += sp) {
          g.moveTo(k, 0);
          g.lineTo(k + T, T);
        }
        g.stroke();
        g.restore();
        g.save();
        g.beginPath();
        g.rect(T / 2, 0, T / 2, T);
        g.clip();
        g.beginPath();
        for (let k = 0; k <= 2 * T; k += sp) {
          g.moveTo(k, 0);
          g.lineTo(k - T, T);
        }
        g.stroke();
        g.restore();
        break;
      }
      case 'chevron': {
        // Repeating ^ stripes (wraps at the cell edges).
        const W = 24;
        const H = 12;
        g.lineWidth = 3;
        g.lineJoin = 'miter';
        g.beginPath();
        for (let y = -H; y <= H * 2; y += H) {
          g.moveTo(0, y);
          g.lineTo(W / 2, y - H / 2);
          g.lineTo(W, y);
        }
        g.stroke();
        break;
      }
      default:
        return null;
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

  // Themed rug under a desk pod, so team islands read as neighbourhoods — each
  // island gets its own base colour + pattern (clipped to the rounded rug).
  private drawPodRug(
    cx: CanvasRenderingContext2D,
    f: { x: number; y: number; w: number; h: number },
    style: FloorStyle,
  ) {
    const theme = FLOOR_THEMES[style.color];
    this.roundRect(cx, f.x, f.y, f.w, f.h, 10);
    cx.fillStyle = theme.base;
    cx.fill();
    // Pattern, clipped to the rug.
    if (style.pattern !== 'none') {
      const pat = this.getFloorPattern(cx, style.pattern, theme.accent);
      if (pat) {
        cx.save();
        this.roundRect(cx, f.x, f.y, f.w, f.h, 10);
        cx.clip();
        cx.fillStyle = pat;
        cx.fillRect(f.x, f.y, f.w, f.h);
        cx.restore();
      }
    }
    cx.strokeStyle = theme.accent;
    cx.lineWidth = 1.5;
    this.roundRect(cx, f.x, f.y, f.w, f.h, 10);
    cx.stroke();
  }

  // Outdoor grass tile: a flat green base, a faint seam grid (matching the indoor
  // floor), and a small deterministic tuft so the lawn isn't a flat slab (#229).
  private drawGrassTile(
    cx: CanvasRenderingContext2D,
    tx: number,
    ty: number,
    col: number,
    row: number,
  ) {
    const S = TILE_SIZE;
    cx.fillStyle = PALETTE.grass;
    cx.fillRect(tx, ty, S, S);
    cx.strokeStyle = PALETTE.grassSeam;
    cx.lineWidth = 1;
    cx.beginPath();
    cx.moveTo(tx + S - 0.5, ty);
    cx.lineTo(tx + S - 0.5, ty + S);
    cx.moveTo(tx, ty + S - 0.5);
    cx.lineTo(tx + S, ty + S - 0.5);
    cx.stroke();
    // One tuft per tile, placed by a cheap hash of (col,row) so it's stable.
    const hx = ((col * 7 + row * 13) % 5) * 8 + 8;
    const hy = ((col * 11 + row * 5) % 5) * 8 + 8;
    cx.strokeStyle = PALETTE.grassTuft;
    cx.lineWidth = 1.5;
    cx.beginPath();
    cx.moveTo(tx + hx, ty + hy);
    cx.lineTo(tx + hx - 2, ty + hy - 5);
    cx.moveTo(tx + hx, ty + hy);
    cx.lineTo(tx + hx + 2, ty + hy - 5);
    cx.stroke();
  }

  // A simple procedural tree on the grass: a short trunk and a layered round
  // canopy. `tiles` is the footprint span (1 = small, 2 = a big 2×2 tree), so the
  // whole thing scales up while staying planted on its footprint (#229).
  private drawTree(cx: CanvasRenderingContext2D, tx: number, ty: number, tiles = 1, variant = 0) {
    const S = TILE_SIZE * tiles;
    const cxp = tx + S / 2;
    const base = ty + S - 6;
    const trunkW = 4 + tiles * 2;
    const trunkH = 10 + tiles * 6;
    const canopy = variant === 1 ? PALETTE.treeCanopy2 : PALETTE.treeCanopy;
    const canopyHi = variant === 1 ? PALETTE.treeCanopyHi2 : PALETTE.treeCanopyHi;
    const canopyShade = variant === 1 ? PALETTE.treeCanopyShade2 : PALETTE.treeCanopyShade;
    this.softShadow(cx, cxp, base + 2, S * 0.34, 5 * tiles);
    cx.fillStyle = PALETTE.treeTrunk;
    cx.fillRect(cxp - trunkW / 2, base - trunkH + 2, trunkW, trunkH);
    const cy = ty + S * 0.42;
    cx.fillStyle = canopyShade;
    this.circle(cx, cxp, cy + 3, S * 0.32);
    cx.fillStyle = canopy;
    this.circle(cx, cxp, cy, S * 0.3);
    cx.fillStyle = canopyHi;
    this.circle(cx, cxp - S * 0.1, cy - S * 0.1, S * 0.14);
  }

  // Warm off-white wall: a light base with a soft top highlight, a subtle bottom
  // shadow, and a faint seam — a clean partition, not the old near-black block.
  private drawWall(
    cx: CanvasRenderingContext2D,
    tx: number,
    ty: number,
    _col: number,
    _row: number,
  ) {
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
    // Idle rooms wear a subtle light-gray pill so they recede; the room you're in
    // keeps the blue accent. Match the name labels' rounder corners.
    ctx.fillStyle = active ? 'rgba(79,140,255,0.85)' : 'rgba(90,96,108,0.6)';
    this.roundRect(ctx, zone.x + 4, zone.y + 4, m.width + padX * 2, lh, 8);
    ctx.fill();
    ctx.fillStyle = active ? 'white' : 'rgba(255,255,255,0.92)';
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
    // The name label is drawn separately, in screen space (drawNameLabels), so it
    // stays a constant readable size at any zoom — see render().
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

// Dev only: the baked map image is cached on the Renderer instance, which
// survives an HMR module swap — so a hot edit to the renderer would leave the map
// (floors, rug patterns/colours, furniture) stale. Force a full reload instead,
// which recreates the Renderer and rebuilds the map. Stripped from prod builds.
if (import.meta.hot) import.meta.hot.accept(() => location.reload());
