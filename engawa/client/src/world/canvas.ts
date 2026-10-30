import { t } from '@/core/i18n';
import type { Point } from '@/core/proximity';
import {
  CONNECT_RADIUS,
  type ItemFacing,
  type ItemKind,
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
import { buildMapCache, roundRect } from '@/world/map-art';
import { drawPlacedItem, placedItems, placedSeatAt } from '@/world/placed-items';
import type { PlayerState } from '@/world/player';
import {
  callZoneAt,
  isDeskSeat,
  podRugAt,
  type Seat,
  seatAt,
  ZONES,
  zoneAt,
} from '@/world/tilemap';

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
 * The part of the map the viewport shows, in world px, clamped to the map and
 * widened to whole pixels. Pure (no DOM) so the camera math is unit-testable.
 * render() blits only this slice of the baked map: handing drawImage the whole
 * 2600×2150 cache and relying on clipping still makes the browser touch far more
 * of the bitmap than is visible, which dominated frame time on HiDPI screens.
 * Returns null when nothing of the map is on screen.
 */
export function visibleMapRect(
  view: { w: number; h: number },
  cam: Point,
  zoom: number,
): { x: number; y: number; w: number; h: number } | null {
  const halfW = view.w / 2 / zoom;
  const halfH = view.h / 2 / zoom;
  const x0 = Math.max(0, Math.floor(cam.x - halfW));
  const y0 = Math.max(0, Math.floor(cam.y - halfH));
  const x1 = Math.min(MAP_WIDTH, Math.ceil(cam.x + halfW));
  const y1 = Math.min(MAP_HEIGHT, Math.ceil(cam.y + halfH));
  if (x1 <= x0 || y1 <= y0) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
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

// Density cap for the baked map. The cache holds the whole map (2600×2150 world
// px), so its memory grows with the square of the density: 2× (a Retina screen)
// is ~89MB of bitmap held for the whole session, 1.5× ~50MB. At 1:1 zoom a
// Retina screen upsamples it by 1.33×, which the flat procedural tiles absorb;
// zoomed in it was already upsampled before this cap.
const MAP_CACHE_MAX_DPR = 1.5;

// Slack, in CSS px, that the background layer is drawn beyond each viewport
// edge. While the camera drifts less than this the layer is just slid with a CSS
// transform (compositor work, no raster); past it the layer is redrawn once.
const BG_MARGIN = 160;
// Beyond the map edge, the grounds green the page background shows (#229).
const OFF_MAP_BG = '#d2e5bf';
// An unchanged scene is not redrawn (see sceneKey), but never left alone longer
// than this — a safety net for state the key doesn't cover (e.g. a sprite sheet
// finishing loading, or an outfit change).
const IDLE_REDRAW_MS = 500;

export class CanvasRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private dpr: number;
  // Background layer under `canvas`: the baked map plus the room frames. It is
  // redrawn only when the zoom, the room we're in or the size changes, or the
  // camera drifts past BG_MARGIN; in between it is slid with a CSS transform.
  // `canvas` itself is transparent and holds only what moves (avatars, labels).
  private bg: HTMLCanvasElement;
  private bgCtx: CanvasRenderingContext2D;
  private bgValid = false;
  private bgCamX = 0;
  private bgCamY = 0;
  private bgZoom = 0;
  private bgZoneId: string | null = null;
  private bgTransform = '';
  // Viewport size in CSS px, refreshed in resize() — reading clientWidth every
  // frame would force a layout whenever anything else touched the DOM.
  private viewWidth = 0;
  private viewHeight = 0;
  // What the avatar layer last drew, and when (see sceneKey / IDLE_REDRAW_MS).
  // Preview of the item about to be placed (placement mode): drawn translucent on
  // the hovered tile, tinted red when it can't go there. null = no preview.
  private ghost: {
    kind: ItemKind;
    col: number;
    row: number;
    facing: ItemFacing;
    valid: boolean;
  } | null = null;
  private ghostKey = '';

  private lastSceneKey = '';
  private lastDrawAt = 0;
  // Decoded profile pictures for the map name labels, keyed by userId. Rebuilt
  // when a player's data URL changes; a freshly decoded image forces one redraw.
  private avatarImages = new Map<string, { url: string; img: HTMLImageElement; ready: boolean }>();

  // The static map (floors/walls/furniture/border) is baked once into this
  // offscreen world-space canvas and blitted per frame, so a richer map is
  // actually cheaper than a per-tile loop. Rebuilt only when the device pixel
  // ratio changes (it is otherwise viewport-independent). null = needs (re)build.
  // Modular avatar sprites (#141). Until it loads, drawPlayer falls back to the
  // colored circle + initials below.
  // A sprite finishing its build must show at once: the unchanged-frame skip
  // (sceneKey) can't see it, so force the next frame to draw.
  private characters = new CharacterSheet(() => {
    this.lastSceneKey = '';
  });
  private mapCache: HTMLCanvasElement | null = null;
  private mapCacheDpr = 0;

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
  // True from panTo() until the camera is touched again, so endLocate() only
  // snaps back a view the user hasn't taken over meanwhile.
  private locating = false;
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
    this.bg = document.createElement('canvas');
    this.bg.setAttribute('aria-hidden', 'true');
    Object.assign(this.bg.style, {
      position: 'absolute',
      left: '0',
      top: '0',
      pointerEvents: 'none',
      willChange: 'transform',
    });
    const bgCtx = this.bg.getContext('2d', { alpha: false });
    if (!bgCtx) throw new Error('2d context not available');
    this.bgCtx = bgCtx;
    // Positioned so it stacks above the absolutely positioned background layer
    // inserted right before it (and still below every later overlay).
    canvas.style.position = 'relative';
    canvas.before(this.bg);
    this.dpr = window.devicePixelRatio || 1;
    this.resize();
    window.addEventListener('resize', () => this.resize());
    // Layout changes that don't resize the window (e.g. the meeting layout) too.
    new ResizeObserver(() => this.resize()).observe(canvas);
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
      this.locating = false;
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
    this.locating = false;
  }

  // Glide the camera to a world point and stop following self — the roster's
  // "where are they?". Zoom is left as it is.
  panTo(x: number, y: number) {
    this.following = false;
    this.camTargetX = x;
    this.camTargetY = y;
    this.camAnimating = true;
    this.locating = true;
  }

  // End a roster locate: back to the view centred on self, but only if nothing
  // else has taken over the camera since panTo (a drag, a zoom button, walking).
  // Returns whether it went back.
  endLocate(): boolean {
    if (!this.locating) return false;
    this.recenter();
    return true;
  }

  // One-button "zoom to me": ease back to the 1:1 view centered on self (#231).
  zoomToSelf() {
    this.zoomTarget = ZOOM_DEFAULT;
    this.following = true;
    this.camAnimating = false;
    this.locating = false;
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
    this.locating = false;
  }

  // Keyboard twin of the two zoom buttons (issue #297): one key flips between the
  // 1:1 view on yourself and the whole-map view. `following` is the honest test
  // of which we're in — zoomToFit clears it and walking (recenter) restores it,
  // so after a walk the key fits the map, which is what you want next.
  toggleZoom() {
    if (this.following) this.zoomToFit();
    else this.zoomToSelf();
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
    this.viewWidth = w;
    this.viewHeight = h;
    this.canvas.width = Math.floor(w * this.dpr);
    this.canvas.height = Math.floor(h * this.dpr);
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const bw = w + BG_MARGIN * 2;
    const bh = h + BG_MARGIN * 2;
    this.bg.width = Math.floor(bw * this.dpr);
    this.bg.height = Math.floor(bh * this.dpr);
    this.bg.style.width = `${bw}px`;
    this.bg.style.height = `${bh}px`;
    this.bgValid = false;
    // Resizing clears the canvas, so the next frame must draw.
    this.lastSceneKey = '';
  }

  get viewW() {
    return this.viewWidth;
  }
  get viewH() {
    return this.viewHeight;
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
    // True while we're in a proximity conversation (any group peer). Used to
    // focus just our own desk pod rug with the same veil as a meeting room.
    inConversation = false,
  ) {
    const ctx = this.ctx;
    const w = this.viewW;
    const h = this.viewH;

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

    // Static layer (map + room frames) lives on the background canvas.
    const selfZone = self ? zoneAt(self.x, self.y) : null;
    this.updateBackground(selfZone?.id ?? null);

    // Most of the time nobody moves: skip the redraw when the frame would come
    // out identical to the one already on screen.
    const sortedPlayers = [...players].sort((a, b) => a.y - b.y);
    const key = this.sceneKey(sortedPlayers, moveTarget, highlightId, mediaActive, inConversation);
    const now = performance.now();
    if (key !== null && key === this.lastSceneKey && now - this.lastDrawAt < IDLE_REDRAW_MS) {
      return;
    }
    this.lastSceneKey = key ?? '';
    this.lastDrawAt = now;
    ctx.clearRect(0, 0, w, h);

    ctx.save();
    // Move origin to the viewport center, scale, then put the camera center at the
    // origin, so it stays centered and only the scale changes (inverse:
    // worldFromScreen).
    ctx.translate(w / 2, h / 2);
    ctx.scale(zoom, zoom);
    ctx.translate(-centerX, -centerY);

    // Self proximity ring — shown only while publishing media (the reach is
    // meaningless otherwise), and hidden inside a meeting room, where the call is
    // governed by room membership (everyone in / nobody out), not radius.
    // The team area is one shared call, so the reach ring means nothing there either.
    if (self && !selfZone && mediaActive && !callZoneAt(self.x, self.y)) {
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

    // User-placed chairs / benches / plants sit on the floor, under the avatars.
    for (const it of placedItems.all()) drawPlacedItem(ctx, it);
    this.drawGhost(ctx);

    // players
    const selfAway = self?.status === 'away';
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
    else if (inConversation && self) {
      // Desk-side chat (#223 follow-up): when a conversation forms on an open-floor
      // desk pod, dim everything outside your own rug so the island reads as a
      // focused little call bubble, just like a meeting room — but scoped to one
      // person's private 3×3 rug (no zone involved).
      const rug = podRugAt(self.x, self.y);
      if (rug) this.drawZoneFocusOverlay(ctx, w, h, rug);
    }

    // Name labels last, in screen space at a constant size (#227), so you can
    // read who is where even zoomed out — and on top of the veil above.
    this.drawNameLabels(ctx, sortedPlayers, w, h, selfAway);
  }

  // Set (or clear, with null) the placement preview; part of the idle-frame key.
  setPlacementGhost(
    g: { kind: ItemKind; col: number; row: number; facing: ItemFacing; valid: boolean } | null,
  ) {
    this.ghost = g;
    this.ghostKey = g ? `${g.kind},${g.col},${g.row},${g.facing},${g.valid}` : '';
  }

  private drawGhost(ctx: CanvasRenderingContext2D) {
    const g = this.ghost;
    if (!g) return;
    if (!g.valid) {
      ctx.fillStyle = 'rgba(229, 72, 77, 0.3)';
      ctx.fillRect(g.col * TILE_SIZE, g.row * TILE_SIZE, TILE_SIZE, TILE_SIZE);
    }
    drawPlacedItem(ctx, g, g.valid ? 0.6 : 0.35);
  }

  // Everything the avatar layer's pixels depend on, as a string; render() skips
  // the frame when it matches the last drawn one. null = animating (a pulsing
  // focus ring, a speech bubble, a floating reaction, a walk cycle), which
  // always redraws.
  private sceneKey(
    players: PlayerState[],
    moveTarget: Point | null,
    highlightId: string | null,
    mediaActive: boolean,
    inConversation: boolean,
  ): string | null {
    if (highlightId !== null || this.reactions.length > 0) return null;
    // Positions to 1/20 px: below that nothing visibly moves, and it lets a
    // remote avatar's exponential ease settle into a stable key.
    const q = (v: number) => Math.round(v * 20);
    let key = `${q(this.camX)},${q(this.camY)},${this.zoomLevel},${this.viewWidth}x${this.viewHeight},${mediaActive},${inConversation}|i${placedItems.version}|g${this.ghostKey}`;
    if (moveTarget) key += `|t${q(moveTarget.x)},${q(moveTarget.y)}`;
    for (const p of players) {
      // Mid-stride (the next draw settles the pose) or a pulsing speech bubble.
      if (p.walkCol() !== 0 || (p.isSpeaking && !p.isSelf)) return null;
      key += `|${p.userId},${q(p.x)},${q(p.y)},${p.facing},${p.status},${p.isSharingScreen},${p.isSpeaking},${p.name},${p.avatarImage?.length ?? 0}`;
    }
    return key;
  }

  // Keep the background layer in step with the camera. Redraws it only when the
  // zoom, the room we're in, the size or the map cache changed, or the camera has
  // drifted past the drawn margin; otherwise it only slides the layer with a CSS
  // transform, which costs no raster work at all.
  private updateBackground(zoneId: string | null) {
    const zoom = this.zoomLevel;
    const dpr = Math.min(this.dpr, MAP_CACHE_MAX_DPR);
    // Rebuild when the device-pixel ratio changes OR the baked image no longer
    // matches the current map size — the latter guards against a stale cache
    // after the map dimensions change (e.g. a hot-reload that widened the outdoor
    // margin), which would otherwise leave the grass/border drawn to the old edge.
    const wantW = Math.round(MAP_WIDTH * dpr);
    if (!this.mapCache || this.mapCacheDpr !== dpr || this.mapCache.width !== wantW) {
      this.mapCache = buildMapCache(dpr);
      this.mapCacheDpr = dpr;
      this.bgValid = false;
    }
    const driftX = (this.camX - this.bgCamX) * zoom;
    const driftY = (this.camY - this.bgCamY) * zoom;
    if (
      !this.bgValid ||
      zoom !== this.bgZoom ||
      zoneId !== this.bgZoneId ||
      Math.abs(driftX) > BG_MARGIN ||
      Math.abs(driftY) > BG_MARGIN
    ) {
      this.drawBackground(zoneId, dpr);
    }
    // Slide by the drift, snapped to device pixels so the map stays crisp.
    const px = (v: number) => Math.round(v * this.dpr) / this.dpr;
    const tx = px(-BG_MARGIN - (this.camX - this.bgCamX) * zoom);
    const ty = px(-BG_MARGIN - (this.camY - this.bgCamY) * zoom);
    const transform = `translate(${tx}px, ${ty}px)`;
    if (transform !== this.bgTransform) {
      this.bgTransform = transform;
      this.bg.style.transform = transform;
    }
  }

  private drawBackground(zoneId: string | null, cacheDpr: number) {
    const ctx = this.bgCtx;
    const zoom = this.zoomLevel;
    const w = this.viewWidth + BG_MARGIN * 2;
    const h = this.viewHeight + BG_MARGIN * 2;
    this.bgCamX = this.camX;
    this.bgCamY = this.camY;
    this.bgZoom = zoom;
    this.bgZoneId = zoneId;
    this.bgValid = true;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = OFF_MAP_BG;
    ctx.fillRect(0, 0, w, h);
    ctx.translate(w / 2, h / 2);
    ctx.scale(zoom, zoom);
    ctx.translate(-this.camX, -this.camY);
    // Source rect in cache px, destination in LOGICAL world px — the destination
    // ctx is already dpr-scaled, so passing device px there would double-scale.
    const vis = visibleMapRect({ w, h }, { x: this.camX, y: this.camY }, zoom);
    if (vis && this.mapCache) {
      ctx.drawImage(
        this.mapCache,
        vis.x * cacheDpr,
        vis.y * cacheDpr,
        vis.w * cacheDpr,
        vis.h * cacheDpr,
        vis.x,
        vis.y,
        vis.w,
        vis.h,
      );
    }
    // Meeting-room zones: frame + name label, highlighted while self is inside.
    for (const zone of ZONES) {
      this.drawZone(ctx, zone, zoneId === zone.id);
    }
  }

  /**
   * Paint what the user currently sees (background layer + avatars) into
   * `ctx` at the given box — for the recording compositor, which used to blit
   * the single floor canvas and now needs both layers.
   */
  drawViewInto(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) {
    const sx = w / this.viewWidth;
    const sy = h / this.viewHeight;
    const off = (v: number, drift: number) => -BG_MARGIN - drift * this.zoomLevel + v;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();
    ctx.drawImage(
      this.bg,
      x + off(0, this.camX - this.bgCamX) * sx,
      y + off(0, this.camY - this.bgCamY) * sy,
      (this.bg.width / this.dpr) * sx,
      (this.bg.height / this.dpr) * sy,
    );
    ctx.drawImage(this.canvas, x, y, w, h);
    ctx.restore();
  }

  // Draw every player's name label in SCREEN space at a fixed size, so labels
  // stay readable at any zoom (unlike the world-space room labels, which scale).
  // Positions are projected from world→screen; overlapping labels are nudged
  // downward so a cluster stays legible (#227).
  // Decode (and cache) a player's profile picture for the map label. Returns the
  // ready <img>, or null while it is still decoding / when the player has none.
  // A change in the data URL rebuilds the entry; a finished decode forces one
  // redraw so the picture appears without waiting for the next scene change.
  private getAvatarImage(userId: string, url: string | null): HTMLImageElement | null {
    if (!url) {
      this.avatarImages.delete(userId);
      return null;
    }
    const entry = this.avatarImages.get(userId);
    if (entry && entry.url === url) return entry.ready ? entry.img : null;
    const img = new Image();
    const rec = { url, img, ready: false };
    img.onload = () => {
      rec.ready = true;
      this.lastSceneKey = '';
    };
    img.src = url;
    this.avatarImages.set(userId, rec);
    return null;
  }

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
    // Profile-picture chip inside the label: a circle a little shorter than the
    // pill, with a small gap to the text.
    const avatarD = lh - 6;
    const avatarGap = 4;
    const placed: { cx: number; top: number; lw: number }[] = [];
    const toDraw: {
      text: string;
      cx: number;
      top: number;
      lw: number;
      isSelf: boolean;
      speaking: boolean;
      avatarImg: HTMLImageElement | null;
    }[] = [];
    for (const p of players) {
      if (p.isSelf && selfAway) continue;
      // Project the avatar's head (world) to screen; the label sits just above it
      // with a constant pixel gap regardless of zoom.
      const sx = (p.x - this.camX) * zoom + w / 2;
      const headY = (p.y - PLAYER_RADIUS - (seatOf(p)?.lift ?? 0) - this.camY) * zoom + h / 2;
      if (sx < -150 || sx > w + 150 || headY < -80 || headY > h + 80) continue;

      const text = `${STATUS_EMOJI[p.status]} ${p.name}${p.isSharingScreen ? '  🖥' : ''}`;
      const avatarImg = this.getAvatarImage(p.userId, p.avatarImage);
      const extra = avatarImg ? avatarD + avatarGap : 0;
      const lw = ctx.measureText(text).width + 12 + extra;
      let top = headY - 6 - lh;

      // Nudge below any already-placed label it overlaps (both axes), so a cluster
      // reads as a vertical stack instead of a pile.
      for (const q of placed) {
        const overlapX = Math.abs(sx - q.cx) < (lw + q.lw) / 2;
        const overlapY = top < q.top + lh + gap && top + lh + gap > q.top;
        if (overlapX && overlapY) top = q.top + lh + gap;
      }
      placed.push({ cx: sx, top, lw });
      // Speech bubble for anyone talking but ourselves (we know we're talking).
      toDraw.push({
        text,
        cx: sx,
        top,
        lw,
        isSelf: p.isSelf,
        speaking: p.isSpeaking && !p.isSelf,
        avatarImg,
      });
    }

    for (const l of toDraw) {
      // Tint our own label a solid indigo so "which one is me" reads at a glance.
      ctx.fillStyle = l.isSelf ? 'rgba(85,70,183,1)' : 'rgba(0,0,0,0.65)';
      const pillLeft = l.cx - l.lw / 2;
      roundRect(ctx, pillLeft, l.top, l.lw, lh, 8);
      ctx.fill();
      let textCx = l.cx;
      if (l.avatarImg) {
        const ax = pillLeft + 5;
        const ay = l.top + (lh - avatarD) / 2;
        ctx.save();
        ctx.beginPath();
        ctx.arc(ax + avatarD / 2, ay + avatarD / 2, avatarD / 2, 0, Math.PI * 2);
        ctx.clip();
        ctx.drawImage(l.avatarImg, ax, ay, avatarD, avatarD);
        ctx.restore();
        // Re-centre the text in the space to the right of the picture.
        textCx = (ax + avatarD + avatarGap + (pillLeft + l.lw - 6)) / 2;
      }
      ctx.fillStyle = 'white';
      ctx.fillText(l.text, textCx, l.top + lh / 2 + 1);
    }
    // Speech bubbles beside the labels (after all labels, so they sit on top and
    // the font state from the loop above no longer matters).
    for (const l of toDraw) {
      if (l.speaking) this.drawSpeechBubble(ctx, l.cx, l.top, l.lw, lh, w);
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
    roundRect(ctx, px, py, pw, ph, 15);
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

  // A small dark speech bubble with three pulsing dots, in SCREEN space, drawn
  // beside a talking peer's name label so it never hides it (to the right, or to
  // the left when that would run off-screen). cx/top/lw describe the label box.
  private drawSpeechBubble(
    ctx: CanvasRenderingContext2D,
    labelCx: number,
    labelTop: number,
    labelLw: number,
    labelH: number,
    viewW: number,
  ) {
    const bw = 32;
    const bh = 20;
    const cy = labelTop + labelH / 2;
    const by = cy - bh / 2;
    // Default to the right of the label; flip to the left if it would overflow.
    let bx = labelCx + labelLw / 2 + 7;
    let onLeft = false;
    if (bx + bw > viewW - 4) {
      bx = labelCx - labelLw / 2 - 7 - bw;
      onLeft = true;
    }
    const now = performance.now();
    ctx.save();
    ctx.fillStyle = 'rgba(255,255,255,0.96)';
    roundRect(ctx, bx, by, bw, bh, 9);
    ctx.fill();
    // A little tail on the bottom, angled back toward the avatar/label so it reads
    // as a speech bubble. Wide and short so the horn is soft, not a sharp spike.
    const tailX = onLeft ? bx + bw - 11 : bx + 11;
    const tipX = onLeft ? bx + bw - 4 : bx + 4;
    ctx.beginPath();
    ctx.moveTo(tailX - 6, by + bh - 1);
    ctx.lineTo(tailX + 6, by + bh - 1);
    ctx.lineTo(tipX, by + bh + 4);
    ctx.closePath();
    ctx.fill();
    for (let i = 0; i < 3; i++) {
      const phase = (now / 450 + i * 0.33) % 1;
      ctx.globalAlpha = 0.4 + 0.6 * (0.5 + 0.5 * Math.sin(phase * Math.PI * 2));
      ctx.fillStyle = '#8a8f99';
      ctx.beginPath();
      ctx.arc(bx + 8 + i * 7, by + bh / 2, 2.1, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
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
    roundRect(ctx, zone.x + 4, zone.y + 4, m.width + padX * 2, lh, 8);
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
    // Standing still on a chair (desk chair / café armchair) draws the seated
    // pose, facing the way the chair faces; walking off stands back up.
    // Advance the walk cycle for this frame first: seatOf() below (and the name
    // label pass) read the column it settles on.
    const col = p.advanceWalk();
    const seat = seatOf(p);
    const drewSprite = this.characters.draw(
      ctx,
      p.outfit,
      seat?.facing ?? p.facing,
      col,
      p.x,
      footY - (seat?.lift ?? 0),
      SPRITE_SCALE,
      seat !== null,
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
}

// The seat an avatar is sitting in, or null when it is standing or moving. Walking
// (any frame but the standing one) stands you back up, so this is also what drives
// the seated pose. Everything anchored to the avatar — sprite, name label, speech
// bubble — shifts by the seat's `lift` together, so they stay as one figure.
// Reads walkCol(), never advanceWalk(): the cycle is advanced once per frame, in
// drawPlayer, and advancing it again here would reset it to the standing frame.
function seatOf(p: PlayerState): Seat | null {
  if (p.walkCol() !== 0) return null;
  // The map's own chairs first, then the ones users have placed.
  return seatAt(p.x, p.y) ?? placedSeatAt(p.x, p.y);
}

// Dev only: the baked map image is cached on the Renderer instance, which
// survives an HMR module swap — so a hot edit to the renderer would leave the map
// (floors, rug patterns/colours, furniture) stale. Force a full reload instead,
// which recreates the Renderer and rebuilds the map. Stripped from prod builds.
if (import.meta.hot) import.meta.hot.accept(() => location.reload());
