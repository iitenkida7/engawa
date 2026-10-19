import { t } from '@/core/i18n';
import type { Direction } from '@/world/outfit';

export const TILE_SIZE = 50;
// The building is a 36×27 floor; the world adds an outdoor grass margin on every
// side (#229), so the full map is larger. The building's tile definitions
// (ROOMS/LOUNGE/OPEN_DESKS/…) stay in building-local coords and are shifted into
// the map by COL_OFF/ROW_OFF when the grid and the exported pixel rects are built.
//
// The left wall moved out two columns (building-local -2 rather than 0) to give
// the president's office half again its old floor; the right wall is where it has
// always been. One wall ring, no doubled-up walls — so every other room/desk
// definition below keeps the coords it has always had.
const BUILDING_C0 = -2; // leftmost building-local column (the left outer wall)
const BUILDING_COLS = 36;
// 27 rows: a horizontal corridor (building-local rows 13-14) separates the two
// open-desk bands so the seat rugs don't meet, and the side gates open onto it
// as a 3-tile exit. Everything below the corridor sits two rows lower than the
// original 25-row layout.
const BUILDING_ROWS = 27;
// Grass margin (tiles) on each side of the building.
export const OUTDOOR_MARGIN = 8;
export const MAP_COLS = BUILDING_COLS + OUTDOOR_MARGIN * 2;
export const MAP_ROWS = BUILDING_ROWS + OUTDOOR_MARGIN * 2;
// Building-local → map tile offsets. Exported so tests/callers can convert.
// Columns carry an extra shift because the building starts at a negative local
// column; rows are just the margin.
export const COL_OFF = OUTDOOR_MARGIN - BUILDING_C0;
export const ROW_OFF = OUTDOOR_MARGIN;
// Pixel offset of building-local (0,0) within the map.
const OFF_X = COL_OFF * TILE_SIZE;
const OFF_Y = ROW_OFF * TILE_SIZE;

export const Tile = {
  FLOOR: 0,
  WALL: 1,
  DESK: 2,
  MEETING: 3,
  LOUNGE: 4,
  PLANT: 5,
  // Outdoor tiles (#229): walkable grass, plus solid trees and a pond on it.
  GRASS: 6,
  TREE: 7,
  POND: 8,
} as const;

export const SOLID = new Set<number>([Tile.WALL, Tile.DESK, Tile.PLANT, Tile.TREE, Tile.POND]);

// Tile colours live with the renderer (world/canvas.ts PALETTE), which draws the
// map procedurally. tilemap.ts stays pure layout + collision.

export function isSolid(px: number, py: number): boolean {
  const col = Math.floor(px / TILE_SIZE);
  const row = Math.floor(py / TILE_SIZE);
  if (col < 0 || col >= MAP_COLS || row < 0 || row >= MAP_ROWS) return true;
  if (SOLID.has(officeMap[row][col])) return true;
  // Sub-tile props that don't align to the grid (e.g. the lounge coffee table).
  for (const r of SOLID_RECTS) {
    if (px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h) return true;
  }
  return false;
}

export function canOccupy(cx: number, cy: number, radius: number): boolean {
  return (
    !isSolid(cx - radius, cy - radius) &&
    !isSolid(cx + radius, cy - radius) &&
    !isSolid(cx - radius, cy + radius) &&
    !isSolid(cx + radius, cy + radius)
  );
}

// ── Rooms: walled-off MEETING zones (isolated call bubbles) ──
// Each room is stamped as a wall ring + MEETING interior + door gap(s) + desks.
// The layout lives here once; buildZones() derives the named Zone from it, so
// adding/moving a room needs no other edits.

// Floor rug patterns the renderer can draw. Named here so a room/café can request
// a specific one; the renderer (canvas.ts) maps each to a drawing.
export type FloorPattern =
  | 'none'
  | 'stripe'
  | 'vstripe'
  | 'checker'
  | 'houndstooth'
  | 'brick'
  | 'crosshatch'
  | 'herringbone'
  | 'chevron';

type RoomDef = {
  id: string;
  name: string;
  // Interior rect, in tiles (the wall ring is stamped just outside it).
  c: number;
  r: number;
  w: number;
  h: number;
  doors: [number, number][]; // wall tiles opened to FLOOR (col, row)
  desks: [number, number][]; // furniture inside (col, row)
};

// Rooms fill the top and bottom edges edge-to-edge: neighbours share a single
// wall column and the perimeter reuses the outer wall (no double walls, no dead
// space). Every room's door opens into the central open office. Desks define the
// table/desk footprint; the renderer draws chairs around it.
const ROOMS: RoomDef[] = [
  // ── Top strip (rows 1-4): president's office + all-hands + three meeting rooms.
  {
    id: 'ceo',
    // Starts two columns left of where the outer wall used to be (the wall moved
    // out with it), so the interior is 6×4 — half as big again as the 4×4 it used
    // to be — without taking anything from the all-hands room next door.
    name: t('zone.ceo'),
    c: -1,
    r: 1,
    w: 6,
    h: 4,
    doors: [
      [1, 5],
      [2, 5],
    ],
    // The same meeting-table footprint as the other rooms, pushed to the left wall
    // to clear the right half for the exec desk (EXEC_DESK_UNITS).
    desks: [
      [-1, 2],
      [0, 2],
      [-1, 3],
      [0, 3],
    ],
  },
  {
    id: 'all-hands',
    name: t('zone.all-hands'),
    c: 6,
    r: 1,
    w: 12,
    h: 4,
    doors: [
      [11, 5],
      [12, 5],
    ],
    // 4×2 boardroom table (chairs drawn around it), leaving standing room for ~25.
    desks: [
      [10, 2],
      [11, 2],
      [12, 2],
      [13, 2],
      [10, 3],
      [11, 3],
      [12, 3],
      [13, 3],
    ],
  },
  {
    id: 'meeting-1',
    name: t('zone.meeting-1'),
    c: 19,
    r: 1,
    w: 4,
    h: 4,
    doors: [
      [20, 5],
      [21, 5],
    ],
    desks: [
      [20, 2],
      [21, 2],
      [20, 3],
      [21, 3],
    ],
  },
  {
    id: 'meeting-2',
    name: t('zone.meeting-2'),
    c: 24,
    r: 1,
    w: 4,
    h: 4,
    doors: [
      [25, 5],
      [26, 5],
    ],
    desks: [
      [25, 2],
      [26, 2],
      [25, 3],
      [26, 3],
    ],
  },
  {
    id: 'meeting-3',
    name: t('zone.meeting-3'),
    c: 29,
    r: 1,
    w: 4,
    h: 4,
    doors: [
      [30, 5],
      [31, 5],
    ],
    desks: [
      [30, 2],
      [31, 2],
      [30, 3],
      [31, 3],
    ],
  },
  // ── Bottom strip (rows 23-25): four 1-on-1 rooms + four negotiation booths,
  // all 3 tiles wide and packed edge-to-edge (shared walls). Each has one centred
  // door and one centred desk. The rightmost room's wall meets the outer wall, so
  // the right edge is one tile thicker — the 1 spare column of the 8-room fit.
  {
    id: '1on1-1',
    name: t('zone.1on1-1'),
    c: -1,
    r: 23,
    w: 3,
    h: 3,
    doors: [[0, 22]],
    desks: [[0, 24]],
  },
  {
    id: '1on1-2',
    name: t('zone.1on1-2'),
    c: 3,
    r: 23,
    w: 3,
    h: 3,
    doors: [[4, 22]],
    desks: [[4, 24]],
  },
  {
    id: '1on1-3',
    name: t('zone.1on1-3'),
    c: 7,
    r: 23,
    w: 3,
    h: 3,
    doors: [[8, 22]],
    desks: [[8, 24]],
  },
  {
    id: '1on1-4',
    name: t('zone.1on1-4'),
    c: 11,
    r: 23,
    w: 3,
    h: 3,
    doors: [[12, 22]],
    desks: [[12, 24]],
  },
  {
    id: 'booth-1',
    name: t('zone.booth-1'),
    c: 15,
    r: 23,
    w: 3,
    h: 3,
    doors: [[16, 22]],
    desks: [[16, 24]],
  },
  {
    id: 'booth-2',
    name: t('zone.booth-2'),
    c: 19,
    r: 23,
    w: 3,
    h: 3,
    doors: [[20, 22]],
    desks: [[20, 24]],
  },
  {
    id: 'booth-3',
    name: t('zone.booth-3'),
    c: 23,
    r: 23,
    w: 3,
    h: 3,
    doors: [[24, 22]],
    desks: [[24, 24]],
  },
  {
    // Same 3 wide as every other booth. The strip is packed from the left wall, so
    // the 2 columns that don't divide evenly are left open at the right end — an
    // alcove under meeting room 3 rather than one odd-sized booth.
    id: 'booth-4',
    name: t('zone.booth-4'),
    c: 27,
    r: 23,
    w: 3,
    h: 3,
    doors: [[28, 22]],
    desks: [[28, 24]],
  },
  // A small standalone room out on the grass past the building's bottom-right
  // corner (a booth-style 3×3: door at top, desk + chairs). Building-local coords
  // land it in the margin.
  {
    id: 'hanare',
    name: t('zone.hanare'),
    c: 36,
    r: 23,
    w: 3,
    h: 3,
    doors: [[37, 22]],
    desks: [[37, 24]],
  },
];

// Furniture footprint for the renderer: the bounding rect of a room's desk tiles
// (the meeting-table surface) plus the room interior rect (to bound chair
// placement). Every room — including the president's office — gets a meeting
// table with chairs.
export type RoomFurniture = {
  x: number;
  y: number;
  w: number;
  h: number;
  ix: number;
  iy: number;
  iw: number;
  ih: number;
};

export const ROOM_FURNITURE: RoomFurniture[] = ROOMS.map((room) => {
  const cols = room.desks.map((d) => d[0]);
  const rows = room.desks.map((d) => d[1]);
  const minC = Math.min(...cols);
  const maxC = Math.max(...cols);
  const minR = Math.min(...rows);
  const maxR = Math.max(...rows);
  return {
    x: minC * TILE_SIZE + OFF_X,
    y: minR * TILE_SIZE + OFF_Y,
    w: (maxC - minC + 1) * TILE_SIZE,
    h: (maxR - minR + 1) * TILE_SIZE,
    ix: room.c * TILE_SIZE + OFF_X,
    iy: room.r * TILE_SIZE + OFF_Y,
    iw: room.w * TILE_SIZE,
    ih: room.h * TILE_SIZE,
  };
});

// The meeting rooms proper (all-hands + meeting-N): the big rooms, as opposed
// to 1-on-1 rooms, booths and cafés.
export function isMeetingRoom(zoneId: string | null | undefined): boolean {
  return !!zoneId && (zoneId === 'all-hands' || zoneId.startsWith('meeting'));
}

// Interior pixel rects of the meeting rooms, for the renderer to add a wall
// whiteboard and a filing cabinet.
export const MEETING_ROOM_RECTS = ROOMS.filter((room) => isMeetingRoom(room.id)).map((room) => ({
  x: room.c * TILE_SIZE + OFF_X,
  y: room.r * TILE_SIZE + OFF_Y,
  w: room.w * TILE_SIZE,
  h: room.h * TILE_SIZE,
}));

// Open-office desks as individual, isolated workstations (#263 follow-up): each
// is a 3-tile-wide desk with ONE chair centred in front, so no two chairs land
// in each other's adjacency ring — a desk seat is a private one-person spot
// until someone steps into the tiles around it (the server shrinks a seated
// person's proximity bubble; see SEAT_CONNECT_RADIUS). Two bands of face-to-face
// islands with wide aisles; the bottom band stays left of the lounge.
type DeskUnit = { col: number; row: number; facing: 'south' | 'north' };

// Island centre columns per band (building-local; the centre column also equals
// the island's left-edge tile counting the left wall as tile 1). Pitch 5 = a
// 3-tile desk block with a 2-tile aisle on each side. Within an island the two
// desk rows face each other (upper row south → chair above, lower row north →
// chair below); centres are ≥5 apart so a chair never lands in a neighbour's ring.
const TOP_ISLAND_COLS = [4, 9, 14, 19, 24, 29];
const BOTTOM_ISLAND_COLS = [4, 9, 14, 19, 24, 29]; // lounge moved outdoors, so full width

const OPEN_DESK_UNITS: DeskUnit[] = [
  ...TOP_ISLAND_COLS.flatMap((col): DeskUnit[] => [
    { col, row: 9, facing: 'south' },
    { col, row: 10, facing: 'north' },
  ]),
  ...BOTTOM_ISLAND_COLS.flatMap((col): DeskUnit[] => [
    { col, row: 17, facing: 'south' },
    { col, row: 18, facing: 'north' },
  ]),
];

// The president's desk (#357 follow-up): the same 3-tile desk + chair unit as the
// open office, but inside the president's office. Facing south puts the chair
// behind the desk against the top wall, so the president faces the door.
const EXEC_DESK_UNITS: DeskUnit[] = [{ col: 3, row: 2, facing: 'south' }];

// Every desk unit on the map. POD_RUGS below deliberately stays on the open-office
// ones — the exec desk sits on the president's office rug, not its own pod.
const DESK_UNITS: DeskUnit[] = [...OPEN_DESK_UNITS, ...EXEC_DESK_UNITS];

// The chair tile sits one row in front of the desk's centre (south → above,
// north → below), building-local.
function seatOf(u: DeskUnit): [number, number] {
  return [u.col, u.row + (u.facing === 'south' ? -1 : 1)];
}

// The three desk tiles of every unit (building-local) — stamped SOLID.
const OPEN_DESKS: [number, number][] = DESK_UNITS.flatMap((u) => [
  [u.col - 1, u.row],
  [u.col, u.row],
  [u.col + 1, u.row],
]);

// Desk tiles drawn facing south (map coords), for the renderer's monitor flip.
const SOUTH_DESK_TILES = new Set<string>(
  DESK_UNITS.filter((u) => u.facing === 'south').flatMap((u) =>
    [u.col - 1, u.col, u.col + 1].map((c) => `${c + COL_OFF},${u.row + ROW_OFF}`),
  ),
);

/** True when the open-office desk at (map col,row) is drawn facing south. */
export function deskFacesSouth(col: number, row: number): boolean {
  return SOUTH_DESK_TILES.has(`${col},${row}`);
}

// Chairs for the renderer (map coords): the desk centre tile + facing; the chair
// is drawn one tile in front of it.
export const OPEN_DESK_CHAIRS: { col: number; row: number; facesSouth: boolean }[] = DESK_UNITS.map(
  (u) => ({
    col: u.col + COL_OFF,
    row: u.row + ROW_OFF,
    facesSouth: u.facing === 'south',
  }),
);

// Seat tiles (map coords) — the whole walkable rug around a desk, not just the
// chair tile: the seat row (chair + its two side tiles) plus the row on the far
// side of the desk, i.e. the 3×3 pod rug minus the solid desk row. Standing
// anywhere on the rug marks you "seated", which privatises your proximity bubble
// (server-side) — so you can shuffle around your own rug without losing the
// private bubble, and others only greet you once they step onto the rug too.
const SEAT_TILES = new Set<string>(
  DESK_UNITS.flatMap((u) => {
    const [sc, sr] = seatOf(u);
    const tiles: string[] = [];
    for (let c = sc - 1; c <= sc + 1; c++) {
      for (let r = sr - 1; r <= sr + 1; r++) {
        if (r === u.row) continue; // skip the solid desk row (can't stand there)
        tiles.push(`${c + COL_OFF},${r + ROW_OFF}`);
      }
    }
    return tiles;
  }),
);

/**
 * True when (px,py) is on a desk's rug (a private one-person spot). The exec desk
 * counts too, though it changes nothing there: its office is a zone, and the
 * server groups zone members by zone without ever looking at the seated flag.
 */
export function isDeskSeat(px: number, py: number): boolean {
  const col = Math.floor(px / TILE_SIZE);
  const row = Math.floor(py / TILE_SIZE);
  return SEAT_TILES.has(`${col},${row}`);
}

/**
 * The pod rug (a seat's 3×3 rect) that (px,py) sits on, or null. Used to focus
 * just your own desk island while a desk-side conversation is active — the same
 * dim veil as a meeting room (#223) but scoped to one person's private rug.
 * The two facing rugs of an island are 3 tiles apart, so a point maps to at
 * most one rug.
 */
export function podRugAt(px: number, py: number): Rect | null {
  for (const rug of POD_RUGS) {
    if (px >= rug.x && px < rug.x + rug.w && py >= rug.y && py < rug.y + rug.h) return rug;
  }
  return null;
}

// Outdoor cafés (#263 follow-up): casual social spots out on the grass beside each
// side gate, so stepping out of the building lands you at one. Each is a
// conversation-restricted zone (an isolated call bubble): walkable rug + sofas +
// a table. Building-local coords deliberately fall in the outdoor margin (well
// left of BUILDING_C0, well past the right wall) so the shared stamping machinery
// places them on the grass.
export type Lounge = { id: string; name: string; c: number; r: number; w: number; h: number };
export const LOUNGES: Lounge[] = [
  // The two sit clear of the gate rows, one below and one above: walking onto a
  // rug joins you to its call, so neither should straddle the way out (or, on the
  // right, the way down to the annex).
  { id: 'cafe-left', name: t('zone.lounge-1'), c: -8, r: 16, w: 6, h: 5 },
  { id: 'cafe-right', name: t('zone.lounge-2'), c: 34, r: 8, w: 6, h: 5 },
];

// Greenery dotted around the open floor — along the side walls and in the aisles
// between the pod rugs. Kept off the island rugs, the central spawn path, the
// lounge, and the room doorways so nothing blocks movement.
const OPEN_PLANTS: [number, number][] = [
  [-1, 6],
  [-1, 21],
  [32, 6],
  [32, 21],
  [7, 12],
  [26, 12],
  // All-hands room corners (interior cols 6-17, rows 1-4) — a little greenery.
  [6, 1],
  [17, 1],
  [6, 4],
  [17, 4],
  // The open alcove left at the right end of the bottom strip.
  [31, 23],
  [32, 25],
];

// Outdoor pond footprint, in MAP-ABSOLUTE tile coords (not building-local): the
// top-right grounds, above the building (rows < OUTDOOR_MARGIN). Solid (you walk
// around it); the renderer draws the water.
export const POND = { c: 44, r: 2, w: 5, h: 4 } as const;

// Building-local top row of the side gates: a 2-tile gap in BOTH the left and
// right outer walls at the open-office corridor, so you can walk out to the
// grounds (#229). The south wall can't be used — the bottom room strip blocks it.
const GATE_R = 13;
const GATE_H = 2;

function buildOfficeMap(): number[][] {
  const m: number[][] = [];
  for (let r = 0; r < MAP_ROWS; r++) {
    m.push(new Array(MAP_COLS).fill(Tile.GRASS));
  }

  // Building helpers: coords are building-local; the margin offset is baked in
  // here, so every ROOMS/LOUNGE/OPEN_* definition below stays unchanged.
  const fill = (c: number, r: number, w: number, h: number, t: number) => {
    for (let rr = r; rr < r + h; rr++)
      for (let cc = c; cc < c + w; cc++) {
        const mr = rr + ROW_OFF;
        const mc = cc + COL_OFF;
        if (mr >= 0 && mr < MAP_ROWS && mc >= 0 && mc < MAP_COLS) m[mr][mc] = t;
      }
  };
  const set = (c: number, r: number, t: number) => {
    const mr = r + ROW_OFF;
    const mc = c + COL_OFF;
    if (mr >= 0 && mr < MAP_ROWS && mc >= 0 && mc < MAP_COLS) m[mr][mc] = t;
  };

  // ── Building floor, then outer walls (building-local) ──
  const bc1 = BUILDING_C0 + BUILDING_COLS - 1; // rightmost building-local column
  fill(BUILDING_C0, 0, BUILDING_COLS, BUILDING_ROWS, Tile.FLOOR);
  fill(BUILDING_C0, 0, BUILDING_COLS, 1, Tile.WALL);
  fill(BUILDING_C0, BUILDING_ROWS - 1, BUILDING_COLS, 1, Tile.WALL);
  fill(BUILDING_C0, 0, 1, BUILDING_ROWS, Tile.WALL);
  fill(bc1, 0, 1, BUILDING_ROWS, Tile.WALL);
  // Side gates: a 2-tile door in each of the left and right walls, at the open
  // corridor, so both sides open onto the grounds.
  for (let dr = GATE_R; dr < GATE_R + GATE_H; dr++) {
    set(BUILDING_C0, dr, Tile.FLOOR);
    set(bc1, dr, Tile.FLOOR);
  }

  // ── Rooms: wall ring → MEETING interior → doors → desks ──
  for (const room of ROOMS) {
    const { c, r, w, h } = room;
    fill(c - 1, r - 1, w + 2, 1, Tile.WALL); // top wall
    fill(c - 1, r + h, w + 2, 1, Tile.WALL); // bottom wall
    fill(c - 1, r - 1, 1, h + 2, Tile.WALL); // left wall
    fill(c + w, r - 1, 1, h + 2, Tile.WALL); // right wall
    fill(c, r, w, h, Tile.MEETING); // interior
    for (const [dc, dr] of room.doors) set(dc, dr, Tile.FLOOR);
    for (const [dc, dr] of room.desks) set(dc, dr, Tile.DESK);
  }

  // ── Outdoor café rugs (walkable), then desk seats + greenery ──
  for (const lo of LOUNGES) fill(lo.c, lo.r, lo.w, lo.h, Tile.LOUNGE);
  for (const [c, r] of OPEN_DESKS) set(c, r, Tile.DESK);
  for (const [c, r] of OPEN_PLANTS) set(c, r, Tile.PLANT);

  // ── Outdoor pond: a water body on the top-right grounds (map-absolute coords).
  // Stamped before placeTrees so the tree scatter avoids it (allGrass check).
  for (let rr = POND.r; rr < POND.r + POND.h; rr++)
    for (let cc = POND.c; cc < POND.c + POND.w; cc++)
      if (rr >= 0 && rr < MAP_ROWS && cc >= 0 && cc < MAP_COLS) m[rr][cc] = Tile.POND;

  return m;
}

export const officeMap = buildOfficeMap();

// One tree on the grounds: its top-left pixel and tile span (1 = small, 2 = a big
// 2×2 tree). The renderer draws from this list; its footprint tiles are stamped
// TREE in officeMap for collision (#229).
export type Tree = { x: number; y: number; tiles: number; variant: number };

// Small deterministic PRNG (mulberry32) so the random tree layout is stable
// across reloads/clients instead of shuffling every build.
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Scatter trees randomly over the grass margin, mixing small (1×1) and big (2×2)
// trees. Stamps each footprint as TREE (solid) and returns the draw instances.
// Keeps clear of the south gate corridor so the exit stays walkable.
function placeTrees(m: number[][]): Tree[] {
  const rng = mulberry32(0x5eed);
  const trees: Tree[] = [];
  const buildingBottom = ROW_OFF + BUILDING_ROWS;
  const buildingLeft = COL_OFF + BUILDING_C0; // last grass col on the left, +1
  const buildingRight = buildingLeft + BUILDING_COLS; // first grass col on the right

  const allGrass = (c: number, r: number, span: number): boolean => {
    for (let rr = r; rr < r + span; rr++)
      for (let cc = c; cc < c + span; cc++) {
        if (rr < 0 || rr >= MAP_ROWS || cc < 0 || cc >= MAP_COLS) return false;
        if (m[rr][cc] !== Tile.GRASS) return false;
      }
    return true;
  };
  // Keep the horizontal corridor outside each side gate clear so the exits stay
  // walkable (both the left and right grass strips at the gate rows).
  const gateTop = ROW_OFF + GATE_R;
  const blocksGate = (c: number, r: number, span: number): boolean =>
    r + span > gateTop - 3 && r < gateTop + 5 && (c < buildingLeft || c + span > buildingRight);

  // Keep trees clear of each room's wall ring + a 1-tile margin, so a detached
  // grass-side room (e.g. the detached annex / 離れ) isn't crowded or overhung.
  const roomKeepouts = ROOMS.map((room) => ({
    c0: room.c + COL_OFF - 2,
    c1: room.c + room.w + COL_OFF + 2,
    r0: room.r + ROW_OFF - 2,
    r1: room.r + room.h + ROW_OFF + 2,
  }));
  const blocksRoom = (c: number, r: number, span: number): boolean =>
    roomKeepouts.some((k) => c < k.c1 && c + span > k.c0 && r < k.r1 && r + span > k.r0);

  // Try to place one tree somewhere in [colMin,colMax]×[rowMin,rowMax]. Biased
  // toward big trees; spaced so nothing clumps. Returns whether it placed.
  // IMPORTANT: every attempt draws the SAME four rng() values up front, whether or
  // not it ends up placing a tree. This decouples the random stream from the map
  // contents, so moving/adding an obstacle (e.g. the pond) only changes the few
  // attempts that actually land on it — not the layout everywhere else.
  const tryPlace = (
    colMin: number,
    colMax: number,
    rowMin: number,
    rowMax: number,
    bigProb = 0.68,
  ): boolean => {
    const tiles = rng() < bigProb ? 2 : 1;
    const c = colMin + Math.floor(rng() * (colMax - colMin + 1));
    const r = rowMin + Math.floor(rng() * (rowMax - rowMin + 1));
    const variant = rng() < 0.5 ? 1 : 0;
    if (blocksGate(c, r, tiles) || blocksRoom(c, r, tiles) || !allGrass(c, r, tiles)) return false;
    // Require a one-tile grass gap around the footprint so trees stay spaced out.
    if (!allGrass(c - 1, r - 1, tiles + 2)) return false;
    for (let rr = r; rr < r + tiles; rr++)
      for (let cc = c; cc < c + tiles; cc++) m[rr][cc] = Tile.TREE;
    trees.push({ x: c * TILE_SIZE, y: r * TILE_SIZE, tiles, variant });
    return true;
  };

  // Place per margin band so the four sides stay balanced (a single uniform
  // scatter left the narrow left/right strips too sparse). Each band gets its own
  // attempt budget scaled to its size.
  const midRow0 = ROW_OFF + 8;
  const midRow1 = buildingBottom - 8;
  // The building is wider than the margin strips are deep, so the top and bottom
  // bands carry most of the greenery; the side strips get their own passes (plus
  // a small-tree pass each) so they never read as bare.
  const bands: [number, number, number, number, number, number][] = [
    [1, MAP_COLS - 2, 1, ROW_OFF - 1, 34, 0.68], // top
    [1, MAP_COLS - 2, buildingBottom, MAP_ROWS - 2, 48, 0.68], // bottom
    // The bottom-centre (below the booths) stays thin under a uniform scatter, so
    // give it a dedicated pass.
    [buildingLeft + 10, buildingRight - 8, buildingBottom, MAP_ROWS - 2, 20, 0.5], // bottom-centre
    [1, buildingLeft - 1, ROW_OFF, buildingBottom - 1, 18, 0.68], // left
    [buildingRight, MAP_COLS - 2, ROW_OFF, buildingBottom - 1, 18, 0.68], // right
    // Fill the sparse side strips with a few small trees so they're not bare.
    [1, buildingLeft - 1, midRow0, midRow1, 12, 0], // left-middle (small)
    [buildingRight, MAP_COLS - 2, midRow0, midRow1, 12, 0], // right-middle (small)
    // Big-tree-only passes on the clear stretches above and below the gates.
    [1, buildingLeft - 1, ROW_OFF + 1, gateTop - 4, 12, 1], // upper-left (big)
    [buildingRight + 1, MAP_COLS - 2, ROW_OFF + 1, gateTop - 4, 12, 1], // upper-right (big)
    [buildingRight + 1, MAP_COLS - 2, buildingBottom + 1, MAP_ROWS - 3, 12, 1], // lower-right (big)
    // Ring the top-right pond with small trees (the allGrass + gap checks keep
    // them off the water and spaced around it).
    [POND.c - 3, POND.c + POND.w + 1, 1, ROW_OFF - 1, 16, 0], // around the pond (small)
  ];
  for (const [colMin, colMax, rowMin, rowMax, attempts, bigProb] of bands) {
    for (let i = 0; i < attempts; i++) tryPlace(colMin, colMax, rowMin, rowMax, bigProb);
  }
  return trees;
}

export const TREES: Tree[] = placeTrees(officeMap);

type Rect = { x: number; y: number; w: number; h: number };

// Pixel rect of the outdoor pond (map-absolute; POND is already in map coords).
export const POND_RECT: Rect = {
  x: POND.c * TILE_SIZE,
  y: POND.r * TILE_SIZE,
  w: POND.w * TILE_SIZE,
  h: POND.h * TILE_SIZE,
};

// Pixel rect of each café, for the renderer (rug accent + sofas/coffee table).
export const LOUNGE_RECTS: Rect[] = LOUNGES.map((lo) => ({
  x: lo.c * TILE_SIZE + OFF_X,
  y: lo.r * TILE_SIZE + OFF_Y,
  w: lo.w * TILE_SIZE,
  h: lo.h * TILE_SIZE,
}));

// Pixel rect of each café's coffee table, centered in the café (46% × 20% of it).
// Shared by the renderer (draws it) and collision (SOLID_RECTS) so the two can't
// drift — you can't walk onto the table (#225).
export const LOUNGE_TABLE_RECTS: Rect[] = LOUNGE_RECTS.map((r) => ({
  x: r.x + r.w / 2 - (r.w * 0.46) / 2,
  y: r.y + r.h / 2 - (r.h * 0.2) / 2,
  w: r.w * 0.46,
  h: r.h * 0.2,
}));

// ===== Sitting spots =====
// Where an avatar is drawn seated (world/canvas.ts): standing still on a desk
// chair's tile or on a café armchair. It is a pure position → facing lookup, so
// every viewer derives the same pose from the positions that are already synced
// — nothing extra goes over the wire, and the server's `seated` flag (the whole
// desk rug, see isDeskSeat) is untouched.

// Armchair layout around each café's coffee table: three above (facing down) and
// three below (facing up), `ARMCHAIR_GAP` from the table edge. The renderer
// (canvas.ts drawLounge) draws the chairs from these same numbers.
export const ARMCHAIR_GAP = 26;
export const ARMCHAIR_DX = [-52, 0, 52];
export const ARMCHAIR_SPOTS: { x: number; y: number; facing: Direction }[] = LOUNGE_RECTS.flatMap(
  (f, i) => {
    const table = LOUNGE_TABLE_RECTS[i];
    const cx = f.x + f.w / 2;
    return ARMCHAIR_DX.flatMap((dx): { x: number; y: number; facing: Direction }[] => [
      { x: cx + dx, y: table.y - ARMCHAIR_GAP, facing: 'down' },
      { x: cx + dx, y: table.y + table.h + ARMCHAIR_GAP, facing: 'up' },
    ]);
  },
);
// How close to an armchair's centre counts as sitting in it.
const ARMCHAIR_SEAT_RADIUS = 25;

/**
 * A sitting spot: which way its occupant faces, and how far UP to draw them (and
 * everything anchored to them) so they land on the chair rather than beside it.
 *
 * Every desk chair is drawn tucked against its desk. For a chair ABOVE its desk
 * that is the near edge of the seat tile — right where an avatar standing in the
 * middle of that tile already has its feet, so no lift. For a chair BELOW its
 * desk it is the FAR edge, a whole tile above those feet, and the avatar read as
 * standing behind its chair. Half a tile closes that gap; a full tile put the
 * avatar up on the desk. The café armchairs are centred on their spot: no lift.
 */
export type Seat = { facing: Direction; lift: number };

// How far up a chair below its desk seats its occupant (see Seat.lift).
const SEAT_LIFT = TILE_SIZE / 2;

// The chair tile of every desk (map coords) → its seat: the desk is in front of
// the chair, so a south-facing unit (chair above) faces down.
const DESK_SEATS = new Map<string, Seat>(
  DESK_UNITS.map((u): [string, Seat] => {
    const [sc, sr] = seatOf(u);
    const south = u.facing === 'south';
    return [
      `${sc + COL_OFF},${sr + ROW_OFF}`,
      { facing: south ? 'down' : 'up', lift: south ? 0 : SEAT_LIFT },
    ];
  }),
);

/**
 * The seat at (px,py), or null when it is not a chair. Pure geometry; the caller
 * decides *when* to sit (standing still).
 */
export function seatAt(px: number, py: number): Seat | null {
  const desk = DESK_SEATS.get(`${Math.floor(px / TILE_SIZE)},${Math.floor(py / TILE_SIZE)}`);
  if (desk) return desk;
  for (const a of ARMCHAIR_SPOTS) {
    if (Math.hypot(px - a.x, py - a.y) <= ARMCHAIR_SEAT_RADIUS) {
      return { facing: a.facing, lift: 0 };
    }
  }
  return null;
}

// ===== Randomised rug styles (#263 follow-up) =====
// Every room, café and desk island gets a (pattern, colour) rug, assigned
// deterministically so it's stable across reloads and unit-testable. Adjacent
// areas never share a pattern OR a colour. The renderer (canvas.ts) maps the
// colour index to a concrete base/accent theme.
export const FLOOR_PATTERNS: FloorPattern[] = [
  'stripe',
  'vstripe',
  'checker',
  'houndstooth',
  'brick',
  'crosshatch',
  'herringbone',
  'chevron',
];
export const FLOOR_COLOR_COUNT = 8;
// Reserved colour index (outside the random 0..FLOOR_COLOR_COUNT-1 range) used
// only for the cafés, so both share a dedicated red theme.
export const CAFE_COLOR = FLOOR_COLOR_COUNT;
export type FloorStyle = { pattern: FloorPattern; color: number };

// FNV-1a hash → a stable per-key ordering of a pool, so each area has its own
// deterministic preference without a global RNG.
function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
function prefOrder(key: string, n: number): number[] {
  return [...Array(n).keys()].sort(
    (a, b) => (hashStr(`${key}#${a}`) % 99991) - (hashStr(`${key}#${b}`) % 99991),
  );
}

// Island ids are `island-k` (top band first, then bottom); 2 pod rugs per island.
function islandId(k: number): string {
  return `island-${k}`;
}

function computeFloorStyles(): Map<string, FloorStyle> {
  const nbrs = new Map<string, string[]>();
  const ensure = (id: string) => {
    if (!nbrs.has(id)) nbrs.set(id, []);
  };
  const edge = (a: string, b: string) => {
    ensure(a);
    ensure(b);
    nbrs.get(a)?.push(b);
    nbrs.get(b)?.push(a);
  };
  // A clique: every member differs from every other, so no pattern/colour
  // repeats within the group (a chain only stops *immediate* neighbours matching,
  // which let e.g. lavender recur along a strip).
  const clique = (ids: string[]) => {
    ids.forEach(ensure);
    for (let i = 0; i < ids.length; i++)
      for (let j = i + 1; j < ids.length; j++) edge(ids[i], ids[j]);
  };

  // Rooms: within each wall-to-wall strip (top / bottom) every room is distinct.
  // The bottom strip is now longer than the pattern pool (the annex came indoors),
  // so past that point only make each room differ from the one beside it —
  // neighbours are what read as "the same rug".
  // Only rooms inside the building form a strip; the detached annex out on the
  // grass gets a free style (ensured below) since nothing sits next to it.
  const inBuilding = (r: RoomDef) =>
    r.c > BUILDING_C0 && r.c + r.w <= BUILDING_C0 + BUILDING_COLS - 1;
  const strip = (rooms: RoomDef[]) => {
    const ids = rooms.sort((a, b) => a.c - b.c).map((r) => r.id);
    const pool = Math.min(FLOOR_PATTERNS.length, FLOOR_COLOR_COUNT);
    clique(ids.slice(0, pool));
    for (let i = pool; i < ids.length; i++) {
      ensure(ids[i]);
      edge(ids[i], ids[i - 1]);
    }
  };
  strip(ROOMS.filter((r) => r.r < 10 && inBuilding(r)));
  strip(ROOMS.filter((r) => r.r >= 10 && inBuilding(r)));
  for (const r of ROOMS) ensure(r.id);
  // Cafés: the two sit opposite each other — just make them differ.
  if (LOUNGES.length === 2) edge(LOUNGES[0].id, LOUNGES[1].id);
  else {
    for (const l of LOUNGES) ensure(l.id);
  }
  // Islands: within each band every island is distinct, and a top island also
  // differs from the bottom island in the same column.
  const topN = TOP_ISLAND_COLS.length;
  const botN = BOTTOM_ISLAND_COLS.length;
  clique(Array.from({ length: topN }, (_, k) => islandId(k)));
  clique(Array.from({ length: botN }, (_, k) => islandId(topN + k)));
  for (let i = 0; i < Math.min(topN, botN); i++) edge(islandId(i), islandId(topN + i));

  // Greedy assignment in a fixed id order. Each edge is respected because the
  // later-assigned endpoint avoids the earlier one; pools are larger than any
  // area's degree, so a free option always exists.
  const styles = new Map<string, FloorStyle>();
  for (const id of [...nbrs.keys()].sort()) {
    const near = nbrs.get(id) ?? [];
    const usedP = new Set(near.map((n) => styles.get(n)?.pattern).filter(Boolean));
    const usedC = new Set(near.map((n) => styles.get(n)?.color).filter((v) => v !== undefined));
    const po = prefOrder(`${id}|p`, FLOOR_PATTERNS.length);
    const co = prefOrder(`${id}|c`, FLOOR_COLOR_COUNT);
    const pi = po.find((i) => !usedP.has(FLOOR_PATTERNS[i])) ?? po[0];
    const ci = co.find((i) => !usedC.has(i)) ?? co[0];
    styles.set(id, { pattern: FLOOR_PATTERNS[pi], color: ci });
  }
  // Cafés are fixed to the reserved red theme (keeping their distinct patterns).
  for (const lo of LOUNGES) {
    const s = styles.get(lo.id);
    if (s) s.color = CAFE_COLOR;
  }
  return styles;
}
const FLOOR_STYLES = computeFloorStyles();

// Rug style for a room/café tile (zone-based), or null when the tile isn't one.
export function floorStyleAt(col: number, row: number): FloorStyle | null {
  const z = zoneAt(col * TILE_SIZE + TILE_SIZE / 2, row * TILE_SIZE + TILE_SIZE / 2);
  return z ? (FLOOR_STYLES.get(z.id) ?? null) : null;
}

// Rug style for the island owning POD_RUGS[rugIndex] (2 rugs per island).
export function islandFloorStyle(rugIndex: number): FloorStyle {
  return FLOOR_STYLES.get(islandId(Math.floor(rugIndex / 2))) ?? { pattern: 'none', color: 0 };
}

// Impassable sub-tile props, checked by isSolid in addition to the SOLID tile
// kinds. Pixel rects so props that don't fill a whole tile still block.
const SOLID_RECTS: Rect[] = [...LOUNGE_TABLE_RECTS];

// One accent rug per SEAT — a 3×3 block centred on the chair, i.e. the exact
// "connect zone" (the seat + its 8 adjacent tiles, SEAT_CONNECT_RADIUS). It
// makes each private seat legible: step onto someone's rug and you connect,
// stay off it and you don't. Two facing seats in an island get two separate
// rugs (they're 3 tiles apart → never in each other's zone). The desk is drawn
// over the desk-side row of the rug.
export const POD_RUGS = OPEN_DESK_UNITS.map((u) => {
  const [sc, sr] = seatOf(u);
  return {
    x: (sc - 1) * TILE_SIZE + OFF_X,
    y: (sr - 1) * TILE_SIZE + OFF_Y,
    w: 3 * TILE_SIZE,
    h: 3 * TILE_SIZE,
  };
});

/**
 * Named meeting-room zone. Rooms act as isolated call bubbles: everyone inside
 * the same zone is connected regardless of distance, and audio/video never
 * leaks to/from people outside (see proximity.ts). The pixel rect is the room's
 * interior bounding box, used for drawing the frame/label and the floor rug.
 */
export type Zone = { id: string; name: string; x: number; y: number; w: number; h: number };

/**
 * Build one named Zone per ROOM. zoneGrid marks only the actual MEETING tiles of
 * each room (not the desks stamped inside), so zoneAt returns a room only where a
 * person can actually stand — while the Zone rect still spans the full interior
 * for drawing the frame/label and the carpet.
 */
function buildZones(): { zones: Zone[]; grid: number[][] } {
  const grid: number[][] = officeMap.map((row) => row.map(() => -1));
  const zones: Zone[] = ROOMS.map((room, idx) => {
    // Mark the whole interior rect (incl. the table/desk + plant tiles), so the
    // room's floor rug shows under the furniture too, not just on standable tiles.
    for (let rr = room.r + ROW_OFF; rr < room.r + room.h + ROW_OFF; rr++) {
      for (let cc = room.c + COL_OFF; cc < room.c + room.w + COL_OFF; cc++) {
        if (rr < 0 || rr >= MAP_ROWS || cc < 0 || cc >= MAP_COLS) continue;
        grid[rr][cc] = idx;
      }
    }
    return {
      id: room.id,
      name: room.name,
      x: room.c * TILE_SIZE + OFF_X,
      y: room.r * TILE_SIZE + OFF_Y,
      w: room.w * TILE_SIZE,
      h: room.h * TILE_SIZE,
    };
  });

  // Each outdoor café is a conversation-restricted zone too (like the booths): an
  // isolated call bubble where everyone inside is connected and audio doesn't
  // leak out — but it has no walls, so its grid cells are its LOUNGE tiles.
  LOUNGES.forEach((lo, i) => {
    const idx = zones.length;
    for (let rr = lo.r + ROW_OFF; rr < lo.r + lo.h + ROW_OFF; rr++) {
      for (let cc = lo.c + COL_OFF; cc < lo.c + lo.w + COL_OFF; cc++) {
        if (rr < 0 || rr >= MAP_ROWS || cc < 0 || cc >= MAP_COLS) continue;
        if (officeMap[rr][cc] === Tile.LOUNGE) grid[rr][cc] = idx;
      }
    }
    zones.push({ id: lo.id, name: lo.name, ...LOUNGE_RECTS[i] });
  });

  return { zones, grid };
}

const { zones: zonesList, grid: zoneGrid } = buildZones();

export const ZONES: Zone[] = zonesList;

// Every zone is a conversation-restricted call bubble (meeting rooms, 1-on-1
// rooms, booths and the outdoor cafés), and the server already puts every zone
// group on the SFU unconditionally (computeProximityGroups: non-null zoneId =>
// meeting group). Entering any of them flips the media view to the full-screen
// immersive meeting layout (issue #263, widened in #287) so the client's
// "meeting mode" and the server's "always SFU" cover exactly the same ground. A
// hallway bump (no zone) keeps the small floating tiles over the map.
export function isMeetingZone(zoneId: string | null | undefined): boolean {
  return !!zoneId;
}

export function zoneAt(px: number, py: number): Zone | null {
  const col = Math.floor(px / TILE_SIZE);
  const row = Math.floor(py / TILE_SIZE);
  if (col < 0 || col >= MAP_COLS || row < 0 || row >= MAP_ROWS) return null;
  const idx = zoneGrid[row][col];
  return idx === -1 ? null : ZONES[idx];
}

/** Find the nearest walkable pixel position, snapping to tile centers. */
export function findWalkableSpawn(
  px: number,
  py: number,
  radius: number,
): { x: number; y: number } {
  if (canOccupy(px, py, radius)) return { x: px, y: py };

  // Spiral outward in tile increments to find a walkable spot
  for (let dist = 1; dist < Math.max(MAP_COLS, MAP_ROWS); dist++) {
    for (let dr = -dist; dr <= dist; dr++) {
      for (let dc = -dist; dc <= dist; dc++) {
        if (Math.abs(dr) !== dist && Math.abs(dc) !== dist) continue;
        const col = Math.floor(px / TILE_SIZE) + dc;
        const row = Math.floor(py / TILE_SIZE) + dr;
        if (col < 0 || col >= MAP_COLS || row < 0 || row >= MAP_ROWS) continue;
        const cx = col * TILE_SIZE + TILE_SIZE / 2;
        const cy = row * TILE_SIZE + TILE_SIZE / 2;
        if (canOccupy(cx, cy, radius)) return { x: cx, y: cy };
      }
    }
  }
  return { x: px, y: py };
}

/**
 * A walkable tile ADJACENT to (tx, ty) — the one of its 8 neighbours nearest to
 * (fromX, fromY). Used to walk up *beside* someone (knock-accept / "go there")
 * instead of onto their exact tile: tile collision ignores player occupancy, so
 * targeting their position lands you overlapping them. Stopping one tile away
 * (50px ≪ CONNECT_RADIUS 120px) still triggers normal proximity. Falls back to
 * findWalkableSpawn when no neighbour is free (e.g. a one-seat booth).
 */
export function findAdjacentSpawn(
  tx: number,
  ty: number,
  fromX: number,
  fromY: number,
  radius: number,
): { x: number; y: number } {
  const tc = Math.floor(tx / TILE_SIZE);
  const tr = Math.floor(ty / TILE_SIZE);
  let best: { x: number; y: number } | null = null;
  let bestDist = Number.POSITIVE_INFINITY;
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (dr === 0 && dc === 0) continue;
      const col = tc + dc;
      const row = tr + dr;
      if (col < 0 || col >= MAP_COLS || row < 0 || row >= MAP_ROWS) continue;
      const cx = col * TILE_SIZE + TILE_SIZE / 2;
      const cy = row * TILE_SIZE + TILE_SIZE / 2;
      if (!canOccupy(cx, cy, radius)) continue;
      const d = (cx - fromX) ** 2 + (cy - fromY) ** 2;
      if (d < bestDist) {
        bestDist = d;
        best = { x: cx, y: cy };
      }
    }
  }
  return best ?? findWalkableSpawn(tx, ty, radius);
}

// Dev only: floor layout/styles are baked into the renderer's cached map image,
// which survives HMR — so a hot edit here would not show. Force a full reload.
if (import.meta.hot) import.meta.hot.accept(() => location.reload());
