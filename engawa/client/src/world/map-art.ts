// Static map art: everything baked once into the offscreen map cache (floors,
// walls, furniture, outdoor grounds). The per-frame renderer (canvas.ts) only
// blits the result, so nothing here runs per frame.

import { MAP_HEIGHT, MAP_WIDTH } from '@/core/types';
import { propFor } from '@/world/decor';
import { FLOOR_THEMES } from '@/world/floor-styles';
import {
  ARMCHAIR_DX,
  ARMCHAIR_GAP,
  type FloorPattern,
  type FloorStyle,
  floorStyleAt,
  LOUNGE_RECTS,
  LOUNGE_TABLE_RECTS,
  MAP_COLS,
  MAP_ROWS,
  MEETING_ROOM_RECTS,
  OPEN_DESK_CHAIRS,
  officeMap,
  POD_RUGS,
  POND_RECTS,
  ROOM_FURNITURE,
  type RoomFurniture,
  TEAM_AREAS,
  TILE_SIZE,
  Tile,
  TREES,
} from '@/world/tilemap';

// ─── Interior theme: 北欧ミニマル / 青山カフェ ───────────────────────────────
// Clean, bright, natural. Light oak plank floors in the open office, soft cream
// rugs in the meeting rooms, warm off-white walls, minimal white desks, and sage
// plants in terracotta pots. Drawn procedurally (no tile sprites), so there are
// no pixel-art patterns and nothing to license for the map.
const PALETTE = {
  floorWood: '#efe3d7', // open-office floor — light warm beige
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
  loungeRugEdge: 'rgba(150,135,110,0.5)', // warm taupe (matches the greige rug)
  sofa: '#9aa7b8',
  sofaShade: '#7f8da0',
  sofaBack: '#78879b',
  sofaArm: '#8b98aa',
  sofaHi: '#b2bdcb',
  coffeeTable: '#a9774f',
  coffeeTableTop: '#c79b70',
  coffeeTableHi: '#dcbb95',
  // Floor lamp (lounge accent).
  lampShade: '#ead9b4',
  lampGlow: 'rgba(255,228,160,0.4)',
  lampPole: '#8a8276',
  lampBase: '#6f685d',
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
  // Outdoor pond (#229 redux): layered water for depth, a damp shore ring, lily
  // pads and glints — richer than the old flat ellipse.
  pondShadow: 'rgba(60,90,70,0.16)',
  pondShore: '#c6d2a6',
  waterDeep: '#3b7b95',
  water: '#58a2bd',
  waterShallow: '#9ccfdd',
  waterEdge: 'rgba(42,92,116,0.5)',
  waterRipple: 'rgba(255,255,255,0.16)',
  waterGlint: 'rgba(255,255,255,0.55)',
  lilyPad: '#5a9b4e',
  lilyPadShade: '#48813f',
  lilyPadHi: 'rgba(160,205,125,0.6)',
  lilyFlower: '#f2d7e6',
  // Rocks ringing the pond: two warm-grey tints with a highlight/shade for form.
  rock: '#a7a299',
  rock2: '#948d82',
  rockHi: '#c6c1b6',
  rockShade: '#6c685f',
  rockShadow: 'rgba(60,70,60,0.18)',
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

// Scale an `rgba(r,g,b,a)` string's alpha by a factor (used to soften heavier
// floor patterns). Returns the input unchanged when it can't be parsed.
function scaleAlpha(rgba: string, factor: number): string {
  if (factor >= 1) return rgba;
  const m = rgba.match(/rgba?\(([^)]+)\)/);
  if (!m) return rgba;
  const [r, g, b, a = '1'] = m[1].split(',').map((s) => s.trim());
  return `rgba(${r}, ${g}, ${b}, ${(Number.parseFloat(a) * factor).toFixed(3)})`;
}

// Floor-pattern cache, keyed by `${pattern}|${accent}` so each colour variant is
// built once and reused across tiles. Cleared on every map (re)build.
const patternCache = new Map<string, CanvasPattern | null>();

// Bakes the whole static map into an offscreen world-space canvas, drawn
// procedurally in the 北欧ミニマル theme: light oak plank floors in the open
// office, cream rugs in the meeting rooms, warm off-white walls, minimal white
// desks, and sage plants in terracotta pots. Runs once (and on dpr change); the
// per-frame path is a single drawImage of this.
export function buildMapCache(dpr: number): HTMLCanvasElement {
  const cache = document.createElement('canvas');
  cache.width = Math.round(MAP_WIDTH * dpr);
  cache.height = Math.round(MAP_HEIGHT * dpr);
  const cx = cache.getContext('2d')!;
  cx.setTransform(dpr, 0, 0, dpr, 0, 0);
  patternCache.clear();

  // Pass 1 — floors + walls: rooms/lounge get a colour-coded rug, the open
  // office oak; walls get a window where they face the open floor.
  for (let r = 0; r < MAP_ROWS; r++) {
    for (let c = 0; c < MAP_COLS; c++) {
      const tx = c * TILE_SIZE;
      const ty = r * TILE_SIZE;
      const tile = officeMap[r][c];
      if (tile === Tile.WALL) {
        drawWall(cx, tx, ty, c, r);
        continue;
      }
      // Outdoor tiles (#229): grass base under trees and the pond too; the pond
      // water shape is painted once below so it reads as a single body.
      if (tile === Tile.GRASS || tile === Tile.TREE || tile === Tile.POND) {
        drawGrassTile(cx, tx, ty, c, r);
        continue;
      }
      // Rooms + cafés get a randomised (pattern, colour) rug; open floor is oak.
      const style = floorStyleAt(c, r);
      if (style) {
        const theme = FLOOR_THEMES[style.color];
        drawFloorTile(cx, tx, ty, theme.base, style.pattern, theme.accent);
      } else {
        drawFloorTile(cx, tx, ty, PALETTE.floorWood, 'none');
      }
    }
  }

  // Outdoor ponds: one layered water body each over the grass, drawn before the
  // trees so their canopies can overhang its edge (collision is the POND tiles).
  for (const rect of POND_RECTS) drawPond(cx, rect);

  // Pod rugs under the desks (over the floor, under the desks), each with its
  // own style, and the team areas' shared rugs.
  for (const rug of POD_RUGS) drawPodRug(cx, rug.rect, rug.style);
  for (const area of TEAM_AREAS) drawPodRug(cx, area.rect, area.style);

  // Pass 2 — props: plants here; open-office desks are drawn per 3-wide unit
  // (one long desk) just below. In-room desks are drawn as designed tables by
  // the furniture pass, so skip them here.
  for (let r = 0; r < MAP_ROWS; r++) {
    for (let c = 0; c < MAP_COLS; c++) {
      if (propFor(officeMap[r][c]) === 'plant') {
        drawPlant(cx, c * TILE_SIZE, r * TILE_SIZE);
      }
    }
  }
  // One long desk per island unit (spans the 3 desk tiles with end margins, so
  // it reads as a ~2-tile desk) + a single centred monitor/keyboard.
  for (const u of OPEN_DESK_CHAIRS) {
    drawWorkstation(cx, u.col * TILE_SIZE, u.row * TILE_SIZE, u.facesSouth);
  }

  // One chair in front of each open-office desk island (centred on the 3-wide
  // desk). Drawn in its own pass AFTER all floors, because the seat sits just
  // in front of the desk (extending into the next tile) and would otherwise be
  // painted over by that row's floor.
  for (const ch of OPEN_DESK_CHAIRS) {
    drawDeskChair(cx, ch.col * TILE_SIZE, ch.row * TILE_SIZE, ch.facesSouth);
  }

  // Meeting-room furniture: proper tables with chairs (and an exec desk for the
  // president's office), drawn over the rug once the tiles are laid down.
  for (const f of ROOM_FURNITURE) drawRoomFurniture(cx, f);

  // Lounge: sofas around a round coffee table, over the sage rug.
  for (let i = 0; i < LOUNGE_RECTS.length; i++)
    drawLounge(cx, LOUNGE_RECTS[i], LOUNGE_TABLE_RECTS[i]);

  // Meeting-room props: a wall whiteboard and a corner filing cabinet.
  for (const rect of MEETING_ROOM_RECTS) {
    drawWhiteboard(cx, rect);
    // The wide all-hands room has corner plants, so nudge its cabinet one tile
    // right of the corner plant; small rooms keep it in the corner.
    drawCabinet(cx, rect, rect.w > 5 * TILE_SIZE ? TILE_SIZE : 0);
  }

  // Outdoor trees on the grounds (small 1×1 and big 2×2), drawn from the random
  // layout over the grass. Sorted by foot Y so nearer trees overlap farther ones.
  for (const tree of [...TREES].sort((a, b) => a.y - b.y)) {
    drawTree(cx, tree.x, tree.y, tree.tiles, tree.variant);
  }

  // Soft map border — a thin warm frame, no heavy vignette (a clean office is
  // bright, so the old dark corner shading is gone).
  cx.strokeStyle = PALETTE.border;
  cx.lineWidth = 2;
  cx.strokeRect(1, 1, MAP_WIDTH - 2, MAP_HEIGHT - 2);

  return cache;
}

// A meeting room's furniture: a table with chairs around it (every room,
// including the president's office).
function drawRoomFurniture(cx: CanvasRenderingContext2D, f: RoomFurniture) {
  // Chairs first (behind the table), then the table over the rug.
  drawChairs(cx, f);
  const inset = 7;
  const x = f.x + inset;
  const y = f.y + inset;
  const w = f.w - inset * 2;
  const h = f.h - inset * 2;
  const r = 9;
  // Drop shadow under the whole table.
  softShadow(cx, f.x + f.w / 2, y + h + 2, w / 2, 8);
  // Table side/thickness: a darker rounded slab offset down a few px.
  roundRect(cx, x, y + 3, w, h, r);
  cx.fillStyle = PALETTE.tableEdge2;
  cx.fill();
  // Top surface with a soft top-to-bottom gradient (a hint of sheen).
  const g = cx.createLinearGradient(0, y, 0, y + h);
  g.addColorStop(0, PALETTE.tableTopHi);
  g.addColorStop(1, PALETTE.tableTop);
  roundRect(cx, x, y, w, h, r);
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
  roundRect(cx, x + 1.5, y + 1.5, w - 3, h - 3, r - 1);
  cx.stroke();
  cx.strokeStyle = PALETTE.deskEdge;
  cx.lineWidth = 1;
  roundRect(cx, x, y, w, h, r);
  cx.stroke();
}

// Chairs along the table's long (top & bottom) sides, one per table column,
// clamped to the room interior so they never land on a wall.
function drawChairs(cx: CanvasRenderingContext2D, f: RoomFurniture) {
  const chair = 15;
  const gap = 5;
  const cols = Math.max(1, Math.round(f.w / TILE_SIZE));
  for (let i = 0; i < cols; i++) {
    const cxp = f.x + (i + 0.5) * (f.w / cols);
    const topY = f.y - gap - chair;
    // Backrest sits on the far side from the table (top chairs: top edge).
    if (topY >= f.iy) drawOfficeChair(cx, cxp, topY, chair, 'top');
    const botY = f.y + f.h + gap;
    if (botY + chair <= f.iy + f.ih) drawOfficeChair(cx, cxp, botY, chair, 'bottom');
  }
}

// A simple chair: a seat with a backrest bar on `back` side (the side away from
// the table) and a soft shadow, so it reads as a chair rather than a square.
function drawOfficeChair(
  cx: CanvasRenderingContext2D,
  cxp: number,
  top: number,
  size: number,
  back: 'top' | 'bottom',
) {
  const backH = size * 0.3;
  softShadow(cx, cxp, top + size + 1, size / 2, 3);
  // Backrest.
  cx.fillStyle = PALETTE.chairBack;
  const backY = back === 'top' ? top : top + size - backH;
  roundRect(cx, cxp - size / 2, backY, size, backH, 3);
  cx.fill();
  // Seat.
  cx.fillStyle = PALETTE.chair;
  const seatY = back === 'top' ? top + backH - 2 : top;
  roundRect(cx, cxp - size / 2 + 1, seatY, size - 2, size - backH + 2, 3);
  cx.fill();
}

// The lounge: a round coffee table with sofas on each side. Purely cosmetic
// (the rug stays walkable), drawn over the sage lounge floor. Placeholder look.
function drawLounge(
  cx: CanvasRenderingContext2D,
  f: { x: number; y: number; w: number; h: number },
  table: { x: number; y: number; w: number; h: number },
) {
  const cxp = f.x + f.w / 2;

  // Framed rug: a double rounded border for a tidy, furnished look.
  roundRect(cx, f.x + 5, f.y + 5, f.w - 10, f.h - 10, 14);
  cx.strokeStyle = PALETTE.loungeRugEdge;
  cx.lineWidth = 2;
  cx.stroke();
  roundRect(cx, f.x + 9, f.y + 9, f.w - 18, f.h - 18, 11);
  cx.lineWidth = 1;
  cx.stroke();

  // Coffee table rect — geometry shared with collision (LOUNGE_TABLE_RECTS).
  const { x: tx, y: ty, w: tw, h: th } = table;

  // Single-seat armchairs, each a spot you stand on to look "seated" (like the
  // meeting-room chairs) — backrest on the side away from the table. Three above
  // (facing down) and three below (facing up).
  const gap = ARMCHAIR_GAP; // chair centre offset from the table edge
  for (const dx of ARMCHAIR_DX) {
    drawArmchair(cx, cxp + dx, ty - gap, 'down');
    drawArmchair(cx, cxp + dx, ty + th + gap, 'up');
  }

  // A potted plant and a floor lamp in the top corners, framing the nook.
  drawPlant(cx, f.x + 6, f.y + 2);
  drawFloorLamp(cx, f.x + f.w - 30, f.y + 62);

  // Rounded coffee table (within the collision rect), lit top + rim.
  const r = Math.min(th / 2, 14);
  softShadow(cx, cxp, ty + th + 2, tw / 2, 6);
  roundRect(cx, tx, ty + 3, tw, th, r); // side/thickness
  cx.fillStyle = PALETTE.coffeeTable;
  cx.fill();
  const tg = cx.createLinearGradient(0, ty, 0, ty + th);
  tg.addColorStop(0, PALETTE.coffeeTableHi);
  tg.addColorStop(1, PALETTE.coffeeTableTop);
  roundRect(cx, tx, ty, tw, th, r);
  cx.fillStyle = tg;
  cx.fill();
  cx.strokeStyle = PALETTE.coffeeTable;
  cx.lineWidth = 1;
  roundRect(cx, tx, ty, tw, th, r);
  cx.stroke();

  // A little plant/vase centred on the table.
  const vy = ty + th / 2;
  cx.fillStyle = PALETTE.pot;
  cx.beginPath();
  cx.moveTo(cxp - 6, vy - 1);
  cx.lineTo(cxp + 6, vy - 1);
  cx.lineTo(cxp + 4, vy + 7);
  cx.lineTo(cxp - 4, vy + 7);
  cx.closePath();
  cx.fill();
  cx.fillStyle = PALETTE.leaf;
  circle(cx, cxp, vy - 5, 6);
  circle(cx, cxp - 5, vy - 1, 4);
  circle(cx, cxp + 5, vy - 1, 4);
  cx.fillStyle = PALETTE.leafDark;
  circle(cx, cxp, vy - 2, 3.5);
}

// A small floor lamp (lounge accent): warm glow, trapezoid shade, thin pole,
// round base. (bx, by) is the base centre; it rises upward from there.
function drawFloorLamp(cx: CanvasRenderingContext2D, bx: number, by: number) {
  const poleH = 40;
  const topY = by - poleH;
  softShadow(cx, bx, by + 2, 10, 4);
  // Base.
  cx.fillStyle = PALETTE.lampBase;
  roundRect(cx, bx - 8, by - 3, 16, 6, 3);
  cx.fill();
  // Pole.
  cx.fillStyle = PALETTE.lampPole;
  cx.fillRect(bx - 1.5, topY, 3, poleH);
  // Warm glow behind the shade.
  cx.fillStyle = PALETTE.lampGlow;
  circle(cx, bx, topY, 16);
  // Trapezoid shade.
  cx.fillStyle = PALETTE.lampShade;
  cx.beginPath();
  cx.moveTo(bx - 7, topY - 10);
  cx.lineTo(bx + 7, topY - 10);
  cx.lineTo(bx + 11, topY + 4);
  cx.lineTo(bx - 11, topY + 4);
  cx.closePath();
  cx.fill();
}

// A couch centred at (cxc, cyc) facing toward the coffee table. `len` is its
// long dimension (so 150 ≈ a 4-seater, 54 ≈ a 2-seater). Backrest on the far
// side, arm caps at both ends, evenly-spaced seat cushions, and a soft shadow.
function drawArmchair(
  cx: CanvasRenderingContext2D,
  cxc: number,
  cyc: number,
  facing: 'left' | 'right' | 'up' | 'down',
) {
  const s = 30; // chair footprint
  const back = 7;
  const arm = 6;
  const x = cxc - s / 2;
  const y = cyc - s / 2;
  softShadow(cx, cxc, y + s + 1, s / 2, 4);
  // Seat base.
  roundRect(cx, x, y, s, s, 8);
  cx.fillStyle = PALETTE.sofa;
  cx.fill();
  // Backrest on the side AWAY from the table (opposite the facing direction).
  cx.fillStyle = PALETTE.sofaBack;
  if (facing === 'down') roundRect(cx, x, y, s, back, 6);
  else if (facing === 'up') roundRect(cx, x, y + s - back, s, back, 6);
  else if (facing === 'right') roundRect(cx, x, y, back, s, 6);
  else roundRect(cx, x + s - back, y, back, s, 6);
  cx.fill();
  // Arm caps on the two sides perpendicular to the facing.
  cx.fillStyle = PALETTE.sofaArm;
  if (facing === 'up' || facing === 'down') {
    roundRect(cx, x, y, arm, s, 5);
    cx.fill();
    roundRect(cx, x + s - arm, y, arm, s, 5);
    cx.fill();
  } else {
    roundRect(cx, x, y, s, arm, 5);
    cx.fill();
    roundRect(cx, x, y + s - arm, s, arm, 5);
    cx.fill();
  }
  // Seat-cushion highlight.
  cx.fillStyle = PALETTE.sofaHi;
  const inset = arm;
  roundRect(cx, x + inset, y + inset, s - inset * 2, s - inset * 2, 4);
  cx.fill();
}

// A wall-mounted whiteboard along the top interior edge of a meeting room, with
// a frame, a pen tray, and a couple of marker scribbles.
function drawWhiteboard(
  cx: CanvasRenderingContext2D,
  rect: { x: number; y: number; w: number; h: number },
) {
  const w = Math.min(rect.w - 20, 86);
  const h = 11;
  const x = rect.x + (rect.w - w) / 2;
  const y = rect.y + 3;
  cx.fillStyle = PALETTE.boardFrame;
  roundRect(cx, x - 2, y - 2, w + 4, h + 6, 2);
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
function drawCabinet(
  cx: CanvasRenderingContext2D,
  rect: { x: number; y: number; w: number; h: number },
  xShift = 0,
) {
  const cw = 16;
  const ch = 24;
  const x = rect.x + 4 + xShift;
  const y = rect.y + rect.h - ch - 4;
  softShadow(cx, x + cw / 2, y + ch + 1, cw / 2 + 1, 4);
  cx.fillStyle = PALETTE.cabinet;
  roundRect(cx, x, y, cw, ch, 2);
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
function drawFloorTile(
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
    const pat = getFloorPattern(cx, pattern, accent);
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
function getFloorPattern(
  cx: CanvasRenderingContext2D,
  pattern: FloorPattern,
  accent: string,
): CanvasPattern | null {
  const key = `${pattern}|${accent}`;
  const hit = patternCache.get(key);
  if (hit !== undefined) return hit;
  const pat = buildFloorPattern(cx, pattern, accent);
  patternCache.set(key, pat);
  return pat;
}

// Builds a repeating accent-coloured tile for one floor pattern. All marks are
// drawn in `accent` over a transparent background, so the tile's base colour
// shows through. Every tile is sized so its motif wraps seamlessly.
function buildFloorPattern(
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
  // Some patterns cover more area and read heavier at the same opacity, so
  // soften them a touch (multiplier on the accent's alpha).
  const softer: Record<string, number> = { vstripe: 0.55, brick: 0.6 };
  const ink = scaleAlpha(accent, softer[pattern] ?? 1);
  g.fillStyle = ink;
  g.strokeStyle = ink;
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
function softShadow(cx: CanvasRenderingContext2D, x: number, y: number, rx: number, ry: number) {
  cx.fillStyle = PALETTE.shadow;
  cx.beginPath();
  cx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
  cx.fill();
}

// Solid themed rug under a desk pod (no pattern — keeps the open office calm;
// patterns stay on the rooms). Each island uses its assigned colour, framed by
// the old double inset border.
function drawPodRug(
  cx: CanvasRenderingContext2D,
  f: { x: number; y: number; w: number; h: number },
  style: FloorStyle,
) {
  const theme = FLOOR_THEMES[style.color];
  roundRect(cx, f.x, f.y, f.w, f.h, 10);
  cx.fillStyle = theme.base;
  cx.fill();
  cx.strokeStyle = theme.accent;
  cx.lineWidth = 1.5;
  cx.stroke();
  // Inset second border line, for a tidy framed-rug look.
  const i = 5;
  roundRect(cx, f.x + i, f.y + i, f.w - i * 2, f.h - i * 2, 7);
  cx.lineWidth = 1;
  cx.stroke();
}

// Outdoor grass tile: a flat green base, a faint seam grid (matching the indoor
// floor), and a small deterministic tuft so the lawn isn't a flat slab (#229).
function drawGrassTile(
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
function drawTree(cx: CanvasRenderingContext2D, tx: number, ty: number, tiles = 1, variant = 0) {
  const S = TILE_SIZE * tiles;
  const cxp = tx + S / 2;
  const base = ty + S - 6;
  const trunkW = 4 + tiles * 2;
  const trunkH = 10 + tiles * 6;
  const canopy = variant === 1 ? PALETTE.treeCanopy2 : PALETTE.treeCanopy;
  const canopyHi = variant === 1 ? PALETTE.treeCanopyHi2 : PALETTE.treeCanopyHi;
  const canopyShade = variant === 1 ? PALETTE.treeCanopyShade2 : PALETTE.treeCanopyShade;
  softShadow(cx, cxp, base + 2, S * 0.34, 5 * tiles);
  cx.fillStyle = PALETTE.treeTrunk;
  cx.fillRect(cxp - trunkW / 2, base - trunkH + 2, trunkW, trunkH);
  const cy = ty + S * 0.42;
  cx.fillStyle = canopyShade;
  circle(cx, cxp, cy + 3, S * 0.32);
  cx.fillStyle = canopy;
  circle(cx, cxp, cy, S * 0.3);
  cx.fillStyle = canopyHi;
  circle(cx, cxp - S * 0.1, cy - S * 0.1, S * 0.14);
}

// Traces a closed, slightly irregular "blob" path (an organic pond outline)
// centred at (cxp,cyp). `scale` shrinks the whole shape (1 = full rect). The
// wobble array is fixed so the shape is deterministic across reloads. Points are
// smoothed with quadratic midpoints so the outline reads as a soft curve.
function pondBlobPath(
  cx: CanvasRenderingContext2D,
  cxp: number,
  cyp: number,
  rx: number,
  ry: number,
  scale: number,
) {
  const wob = [1.0, 0.9, 1.06, 0.88, 1.08, 0.92, 1.03, 0.86];
  const n = wob.length;
  const pts: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const r = wob[i] * scale;
    pts.push([cxp + Math.cos(a) * rx * r, cyp + Math.sin(a) * ry * r]);
  }
  cx.beginPath();
  const first = pts[0];
  const last = pts[n - 1];
  cx.moveTo((first[0] + last[0]) / 2, (first[1] + last[1]) / 2);
  for (let i = 0; i < n; i++) {
    const cur = pts[i];
    const nxt = pts[(i + 1) % n];
    cx.quadraticCurveTo(cur[0], cur[1], (cur[0] + nxt[0]) / 2, (cur[1] + nxt[1]) / 2);
  }
  cx.closePath();
}

// The outdoor pond: a damp shore ring, a depth-graded water body with concentric
// ripples, specular glints, and a few lily pads — drawn over the grass. Collision
// is handled by the POND tiles underneath (#229).
function drawPond(
  cx: CanvasRenderingContext2D,
  rect: { x: number; y: number; w: number; h: number },
) {
  const cxp = rect.x + rect.w / 2;
  const cyp = rect.y + rect.h / 2;
  const rx = rect.w / 2;
  const ry = rect.h / 2;
  const minR = Math.min(rx, ry);
  cx.save();

  // 1. Soft ground shadow, nudged down, so the pond sits in the lawn.
  pondBlobPath(cx, cxp, cyp + 4, rx * 0.98, ry * 0.98, 1);
  cx.fillStyle = PALETTE.pondShadow;
  cx.fill();

  // 2. Damp shore ring just outside the water.
  pondBlobPath(cx, cxp, cyp, rx * 0.98, ry * 0.98, 1);
  cx.fillStyle = PALETTE.pondShore;
  cx.fill();

  // 3. Water body: clip to the (slightly inset) blob, fill with a depth gradient.
  pondBlobPath(cx, cxp, cyp, rx, ry, 0.86);
  cx.save();
  cx.clip();
  const g = cx.createRadialGradient(
    cxp - rx * 0.22,
    cyp - ry * 0.24,
    minR * 0.1,
    cxp,
    cyp,
    Math.max(rx, ry) * 0.95,
  );
  g.addColorStop(0, PALETTE.waterShallow);
  g.addColorStop(0.5, PALETTE.water);
  g.addColorStop(1, PALETTE.waterDeep);
  cx.fillStyle = g;
  cx.fillRect(rect.x - 20, rect.y - 20, rect.w + 40, rect.h + 40);
  // Concentric ripples.
  cx.strokeStyle = PALETTE.waterRipple;
  cx.lineWidth = 2;
  for (const f of [0.74, 0.52, 0.3]) {
    cx.beginPath();
    cx.ellipse(cxp, cyp, rx * f * 0.86, ry * f * 0.86, 0, 0, Math.PI * 2);
    cx.stroke();
  }
  cx.restore();

  // 4. Rim stroke on the waterline.
  pondBlobPath(cx, cxp, cyp, rx, ry, 0.86);
  cx.strokeStyle = PALETTE.waterEdge;
  cx.lineWidth = 2.5;
  cx.stroke();

  // 5. Specular glints near the top-left (light source).
  cx.fillStyle = PALETTE.waterGlint;
  cx.beginPath();
  cx.ellipse(cxp - rx * 0.34, cyp - ry * 0.32, rx * 0.16, ry * 0.07, -0.5, 0, Math.PI * 2);
  cx.fill();
  cx.beginPath();
  cx.ellipse(cxp - rx * 0.12, cyp - ry * 0.12, rx * 0.07, ry * 0.035, -0.5, 0, Math.PI * 2);
  cx.fill();

  // 6. A few lily pads scattered on the surface.
  drawLilyPad(cx, cxp + rx * 0.34, cyp + ry * 0.22, minR * 0.2);
  drawLilyPad(cx, cxp - rx * 0.28, cyp + ry * 0.36, minR * 0.15);
  drawLilyPad(cx, cxp + rx * 0.08, cyp - ry * 0.34, minR * 0.13);

  // 7. A ring of rocks bordering the pond, sitting on the shore so they straddle
  // the waterline. Deterministic angle/radius/size jitter so it never shuffles.
  const rj = [0.0, 0.35, -0.2, 0.15, -0.3, 0.25, -0.1, 0.3, -0.25, 0.1, -0.15, 0.2];
  const rrf = [0.98, 1.02, 0.95, 1.0, 1.03, 0.97, 1.01, 0.96, 1.02, 0.99, 0.94, 1.0];
  const rsz = [0.26, 0.2, 0.3, 0.22, 0.18, 0.28, 0.23, 0.19, 0.27, 0.21, 0.31, 0.24];
  const count = rj.length;
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2 + rj[i] * 0.4;
    const rockX = cxp + Math.cos(a) * rx * rrf[i] * 0.98;
    const rockY = cyp + Math.sin(a) * ry * rrf[i] * 0.98;
    drawRock(cx, rockX, rockY, minR * rsz[i], i);
  }

  cx.restore();
}

// One shoreline rock: a soft drop shadow, a rounded two-lobe body in an
// alternating grey tint, a lit top-left cap and a shaded base — small enough to
// read as a stone, not a boulder. `seed` just alternates the tint.
function drawRock(cx: CanvasRenderingContext2D, x: number, y: number, s: number, seed: number) {
  cx.fillStyle = PALETTE.rockShadow;
  cx.beginPath();
  cx.ellipse(x, y + s * 0.35, s * 1.1, s * 0.5, 0, 0, Math.PI * 2);
  cx.fill();
  cx.fillStyle = seed % 2 === 0 ? PALETTE.rock : PALETTE.rock2;
  cx.beginPath();
  cx.ellipse(x, y, s, s * 0.78, 0, 0, Math.PI * 2);
  cx.fill();
  cx.fillStyle = PALETTE.rockShade;
  cx.beginPath();
  cx.ellipse(x, y + s * 0.2, s * 0.86, s * 0.42, 0, 0, Math.PI);
  cx.fill();
  cx.fillStyle = PALETTE.rockHi;
  cx.beginPath();
  cx.ellipse(x - s * 0.28, y - s * 0.28, s * 0.42, s * 0.28, -0.5, 0, Math.PI * 2);
  cx.fill();
}

// A single lily pad: a round leaf with a V-notch, a lighter highlight, and a
// small flower on the biggest ones.
function drawLilyPad(cx: CanvasRenderingContext2D, x: number, y: number, r: number) {
  cx.fillStyle = PALETTE.lilyPadShade;
  cx.beginPath();
  cx.ellipse(x, y + 1.5, r, r * 0.82, 0, 0.5, Math.PI * 2 + 0.2);
  cx.lineTo(x, y + 1.5);
  cx.closePath();
  cx.fill();
  cx.fillStyle = PALETTE.lilyPad;
  cx.beginPath();
  cx.ellipse(x, y, r, r * 0.82, 0, 0.5, Math.PI * 2 + 0.2);
  cx.lineTo(x, y);
  cx.closePath();
  cx.fill();
  cx.fillStyle = PALETTE.lilyPadHi;
  cx.beginPath();
  cx.ellipse(x - r * 0.18, y - r * 0.18, r * 0.42, r * 0.3, 0, 0, Math.PI * 2);
  cx.fill();
  if (r > 16) {
    cx.fillStyle = PALETTE.lilyFlower;
    circle(cx, x + r * 0.15, y - r * 0.1, r * 0.22);
  }
}

// Warm off-white wall: a light base with a soft top highlight, a subtle bottom
// shadow, and a faint seam — a clean partition, not the old near-black block.
function drawWall(
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
// (tx, ty) is the CENTRE tile of a 3-wide desk unit. Draws one long desk across
// the three tiles — inset at both ends so it reads as a ~2-tile desk — with a
// single centred monitor/keyboard.
function drawWorkstation(cx: CanvasRenderingContext2D, tx: number, ty: number, facesSouth = false) {
  const S = TILE_SIZE;
  const pad = 5;
  const end = S * 0.45; // end margin: the slab spans ~2 tiles, not the full 3
  const slabX = tx - S + end;
  const slabW = 3 * S - end * 2;
  const slabY = ty + pad;
  const slabH = S - pad * 2;
  const cxm = tx + S / 2;
  softShadow(cx, cxm, ty + S - pad + 1, slabW / 2 - pad + 1, 5);
  // Desk: thickness slab, then a gradient top and rim.
  roundRect(cx, slabX, slabY + 2, slabW, slabH, 7);
  cx.fillStyle = PALETTE.deskEdge;
  cx.fill();
  const dg = cx.createLinearGradient(0, slabY, 0, slabY + slabH);
  dg.addColorStop(0, PALETTE.deskTopHi);
  dg.addColorStop(1, PALETTE.deskTop);
  roundRect(cx, slabX, slabY, slabW, slabH, 7);
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
  roundRect(cx, mx, my, mw, mh, 2);
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
  roundRect(cx, cxm - S * 0.22, ky, S * 0.34, 6, 2);
  cx.fill();
  cx.fillStyle = PALETTE.mouse;
  roundRect(cx, cxm + S * 0.16, ky + 1, 4, 5, 2);
  cx.fill();
}

// A chair just in front of an open-office desk. Default: below the desk (the
// occupant faces up). `facesSouth` puts it above the desk (occupant faces
// down). Same sage rounded seat as the meeting chairs, for consistency.
function drawDeskChair(cx: CanvasRenderingContext2D, tx: number, ty: number, facesSouth = false) {
  const S = TILE_SIZE;
  const size = 16;
  const top = facesSouth ? ty - size + 6 : ty + S - 6;
  drawOfficeChair(cx, tx + S / 2, top, size, facesSouth ? 'top' : 'bottom');
}

// Sage plant in a terracotta pot: a small trapezoid pot with a cluster of
// rounded leaves — a bit of greenery without pixel-art clutter.
function drawPlant(cx: CanvasRenderingContext2D, tx: number, ty: number) {
  const S = TILE_SIZE;
  const cx0 = tx + S / 2;
  softShadow(cx, cx0, ty + S * 0.86, S * 0.26, S * 0.08);
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
  circle(cx, cx0, ty + S * 0.4, S * 0.2);
  circle(cx, cx0 - S * 0.15, ty + S * 0.5, S * 0.15);
  circle(cx, cx0 + S * 0.15, ty + S * 0.5, S * 0.15);
  cx.fillStyle = PALETTE.leafDark;
  circle(cx, cx0, ty + S * 0.5, S * 0.12);
}

function circle(cx: CanvasRenderingContext2D, x: number, y: number, r: number) {
  cx.beginPath();
  cx.arc(x, y, r, 0, Math.PI * 2);
  cx.fill();
}

export function roundRect(
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
