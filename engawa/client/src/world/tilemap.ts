import { t } from '@/core/i18n';

export const TILE_SIZE = 50;
// The building itself is a compact 34×24 floor; the world adds an outdoor grass
// margin on every side (#229), so the full map is larger. The building's tile
// definitions (ROOMS/LOUNGE/OPEN_DESKS/…) stay in building-local coords and are
// shifted into the map by OUTDOOR_MARGIN when the grid and the exported pixel
// rects are built — so nothing below needs to know about the margin.
const BUILDING_COLS = 34;
const BUILDING_ROWS = 25;
// Grass margin (tiles) on each side of the building. Exported so tests/callers
// can convert building-local coords to map coords.
export const OUTDOOR_MARGIN = 6;
export const MAP_COLS = BUILDING_COLS + OUTDOOR_MARGIN * 2;
export const MAP_ROWS = BUILDING_ROWS + OUTDOOR_MARGIN * 2;
// Pixel offset of the building's origin within the map.
const OFF_X = OUTDOOR_MARGIN * TILE_SIZE;
const OFF_Y = OUTDOOR_MARGIN * TILE_SIZE;

export const Tile = {
  FLOOR: 0,
  WALL: 1,
  DESK: 2,
  MEETING: 3,
  LOUNGE: 4,
  PLANT: 5,
  // Outdoor tiles (#229): walkable grass, plus solid trees on it.
  GRASS: 6,
  TREE: 7,
} as const;

export const SOLID = new Set<number>([Tile.WALL, Tile.DESK, Tile.PLANT, Tile.TREE]);

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
    name: t('zone.ceo'),
    c: 1,
    r: 1,
    w: 4,
    h: 4,
    doors: [
      [2, 5],
      [3, 5],
    ],
    // Same meeting-table footprint as the other rooms.
    desks: [
      [2, 2],
      [3, 2],
      [2, 3],
      [3, 3],
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
  // ── Bottom strip (rows 21-23): four 1-on-1 rooms + four negotiation booths,
  // all 3 tiles wide and packed edge-to-edge (shared walls). Each has one centred
  // door and one centred desk. The rightmost room's wall meets the outer wall, so
  // the right edge is one tile thicker — the 1 spare column of the 8-room fit.
  {
    id: '1on1-1',
    name: t('zone.1on1-1'),
    c: 1,
    r: 21,
    w: 3,
    h: 3,
    doors: [[2, 20]],
    desks: [[2, 22]],
  },
  {
    id: '1on1-2',
    name: t('zone.1on1-2'),
    c: 5,
    r: 21,
    w: 3,
    h: 3,
    doors: [[6, 20]],
    desks: [[6, 22]],
  },
  {
    id: '1on1-3',
    name: t('zone.1on1-3'),
    c: 9,
    r: 21,
    w: 3,
    h: 3,
    doors: [[10, 20]],
    desks: [[10, 22]],
  },
  {
    id: '1on1-4',
    name: t('zone.1on1-4'),
    c: 13,
    r: 21,
    w: 3,
    h: 3,
    doors: [[14, 20]],
    desks: [[14, 22]],
  },
  {
    id: 'booth-1',
    name: t('zone.booth-1'),
    c: 17,
    r: 21,
    w: 3,
    h: 3,
    doors: [[18, 20]],
    desks: [[18, 22]],
  },
  {
    id: 'booth-2',
    name: t('zone.booth-2'),
    c: 21,
    r: 21,
    w: 3,
    h: 3,
    doors: [[22, 20]],
    desks: [[22, 22]],
  },
  {
    id: 'booth-3',
    name: t('zone.booth-3'),
    c: 25,
    r: 21,
    w: 3,
    h: 3,
    doors: [[26, 20]],
    desks: [[26, 22]],
  },
  {
    // One tile wider than the other booths so its right wall meets the outer wall
    // directly (no doubled wall / spare column on the right edge).
    id: 'booth-4',
    name: t('zone.booth-4'),
    c: 29,
    r: 21,
    w: 4,
    h: 3,
    doors: [[30, 20]],
    desks: [[30, 22]],
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

// Interior pixel rects of the meeting rooms (all-hands + meeting-N), for the
// renderer to add a wall whiteboard and a filing cabinet.
export const MEETING_ROOM_RECTS = ROOMS.filter(
  (room) => room.id === 'all-hands' || room.id.startsWith('meeting'),
).map((room) => ({
  x: room.c * TILE_SIZE + OFF_X,
  y: room.r * TILE_SIZE + OFF_Y,
  w: room.w * TILE_SIZE,
  h: room.h * TILE_SIZE,
}));

// 26 open-office seats grouped into team "islands" (pods) instead of uniform
// benches. Within a pod the two desk-rows are adjacent and face each other: the
// upper row faces south (monitor flipped down, chair above), the lower faces
// north, so people sit across the island. Wide aisles run between the pods.
//   Top pod-row (desks on rows 9/10):   four 4-seat islands.
//   Bottom pod-row (desks on rows 15/16): two 4-seat islands + one 6-seat island.
const OPEN_DESKS: [number, number][] = [
  // ── Top row: four 4-seat pods (upper desk row 9 faces south, row 10 north) ──
  [4, 9],
  [5, 9],
  [4, 10],
  [5, 10],
  [11, 9],
  [12, 9],
  [11, 10],
  [12, 10],
  [19, 9],
  [20, 9],
  [19, 10],
  [20, 10],
  [27, 9],
  [28, 9],
  [27, 10],
  [28, 10],
  // ── Bottom row: two 4-seat pods ──
  [5, 15],
  [6, 15],
  [5, 16],
  [6, 16],
  [11, 15],
  [12, 15],
  [11, 16],
  [12, 16],
  // ── Bottom row: one 6-seat pod (3 wide × 2 rows) ──
  [18, 15],
  [19, 15],
  [20, 15],
  [18, 16],
  [19, 16],
  [20, 16],
];

// The upper desk-row of each pod faces SOUTH (chair above the desk, monitor
// flipped to the bottom) so a pod's two rows sit face-to-face — two people
// looking at each other across the island. These are the open-office desks on
// rows 9 and 15 (the lower rows, 10 and 16, keep the default north facing).
const SOUTH_FACING_DESK_ROWS = new Set<number>([9 + OUTDOOR_MARGIN, 15 + OUTDOOR_MARGIN]);

/** True when the open-office desk at (col,row) is drawn facing south (flipped). */
export function deskFacesSouth(col: number, row: number): boolean {
  return SOUTH_FACING_DESK_ROWS.has(row) && officeMap[row]?.[col] === Tile.DESK;
}

// A casual lounge in the open bottom-right corner: an OPEN social spot (not a
// walled zone / isolated call bubble), so people on spatial audio can gather and
// chat. Walkable rug (LOUNGE tiles aren't SOLID); the renderer draws sofas + a
// coffee table on top. Placed clear of the desk pods and the booth doors below.
// (Design is a placeholder — easy to restyle later.)
export const LOUNGE = { c: 24, r: 13, w: 7, h: 5 } as const;

// Greenery dotted around the open floor — along the side walls and in the aisles
// between the pod rugs. Kept off the island rugs, the central spawn path, the
// lounge, and the room doorways so nothing blocks movement.
const OPEN_PLANTS: [number, number][] = [
  [1, 6],
  [1, 19],
  [32, 6],
  [32, 19],
  [8, 12],
  [25, 12],
  // All-hands room corners (interior cols 6-17, rows 1-4) — a little greenery.
  [6, 1],
  [17, 1],
  [6, 4],
  [17, 4],
];

// Building-local top row of the side gates: a 2-tile gap in BOTH the left and
// right outer walls at the open-office aisle, so you can walk out to the grounds
// (#229). The south wall can't be used — the bottom room strip blocks it.
const GATE_R = 12;

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
        const mr = rr + OUTDOOR_MARGIN;
        const mc = cc + OUTDOOR_MARGIN;
        if (mr >= 0 && mr < MAP_ROWS && mc >= 0 && mc < MAP_COLS) m[mr][mc] = t;
      }
  };
  const set = (c: number, r: number, t: number) => {
    const mr = r + OUTDOOR_MARGIN;
    const mc = c + OUTDOOR_MARGIN;
    if (mr >= 0 && mr < MAP_ROWS && mc >= 0 && mc < MAP_COLS) m[mr][mc] = t;
  };

  // ── Building floor, then outer walls (building-local) ──
  fill(0, 0, BUILDING_COLS, BUILDING_ROWS, Tile.FLOOR);
  fill(0, 0, BUILDING_COLS, 1, Tile.WALL);
  fill(0, BUILDING_ROWS - 1, BUILDING_COLS, 1, Tile.WALL);
  fill(0, 0, 1, BUILDING_ROWS, Tile.WALL);
  fill(BUILDING_COLS - 1, 0, 1, BUILDING_ROWS, Tile.WALL);
  // Side gates: a 2-tile door in each of the left and right walls, at the open
  // aisle, so both sides open onto the grounds.
  for (const dr of [GATE_R, GATE_R + 1]) {
    set(0, dr, Tile.FLOOR);
    set(BUILDING_COLS - 1, dr, Tile.FLOOR);
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

  // ── Lounge rug (walkable), then open-office desk seats + greenery ──
  fill(LOUNGE.c, LOUNGE.r, LOUNGE.w, LOUNGE.h, Tile.LOUNGE);
  for (const [c, r] of OPEN_DESKS) set(c, r, Tile.DESK);
  for (const [c, r] of OPEN_PLANTS) set(c, r, Tile.PLANT);

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
  const buildingBottom = OUTDOOR_MARGIN + BUILDING_ROWS;
  const buildingRight = OUTDOOR_MARGIN + BUILDING_COLS; // first grass col on the right

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
  const gateTop = OUTDOOR_MARGIN + GATE_R;
  const blocksGate = (c: number, r: number, span: number): boolean =>
    r + span > gateTop - 3 && r < gateTop + 5 && (c < OUTDOOR_MARGIN || c + span > buildingRight);

  // Try to place one tree somewhere in [colMin,colMax]×[rowMin,rowMax]. Biased
  // toward big trees; spaced so nothing clumps. Returns whether it placed.
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
    if (blocksGate(c, r, tiles) || !allGrass(c, r, tiles)) return false;
    // Require a one-tile grass gap around the footprint so trees stay spaced out.
    if (!allGrass(c - 1, r - 1, tiles + 2)) return false;
    for (let rr = r; rr < r + tiles; rr++)
      for (let cc = c; cc < c + tiles; cc++) m[rr][cc] = Tile.TREE;
    trees.push({ x: c * TILE_SIZE, y: r * TILE_SIZE, tiles, variant: rng() < 0.5 ? 1 : 0 });
    return true;
  };

  // Place per margin band so the four sides stay balanced (a single uniform
  // scatter left the narrow left/right strips too sparse). Each band gets its own
  // attempt budget scaled to its size.
  const midRow0 = OUTDOOR_MARGIN + 8;
  const midRow1 = buildingBottom - 8;
  const bands: [number, number, number, number, number, number][] = [
    [1, MAP_COLS - 2, 1, OUTDOOR_MARGIN - 1, 24, 0.68], // top
    [1, MAP_COLS - 2, buildingBottom, MAP_ROWS - 2, 24, 0.68], // bottom
    [1, OUTDOOR_MARGIN - 1, OUTDOOR_MARGIN, buildingBottom - 1, 18, 0.68], // left
    [buildingRight, MAP_COLS - 2, OUTDOOR_MARGIN, buildingBottom - 1, 18, 0.68], // right
    // Fill the sparse right-middle strip with a few small trees so it's not bare.
    [buildingRight, MAP_COLS - 2, midRow0, midRow1, 12, 0], // right-middle (small)
  ];
  for (const [colMin, colMax, rowMin, rowMax, attempts, bigProb] of bands) {
    for (let i = 0; i < attempts; i++) tryPlace(colMin, colMax, rowMin, rowMax, bigProb);
  }
  return trees;
}

export const TREES: Tree[] = placeTrees(officeMap);

// Pixel rect of the lounge, for the renderer (rug accent + sofas/coffee table).
export const LOUNGE_RECT = {
  x: LOUNGE.c * TILE_SIZE + OFF_X,
  y: LOUNGE.r * TILE_SIZE + OFF_Y,
  w: LOUNGE.w * TILE_SIZE,
  h: LOUNGE.h * TILE_SIZE,
};

// Pixel rect of the lounge coffee table, centered in the lounge (46% × 20% of
// it). Shared by the renderer (draws it) and collision (SOLID_RECTS) so the two
// can't drift — you can't walk onto the table (#225).
export const LOUNGE_TABLE_RECT = {
  x: LOUNGE_RECT.x + LOUNGE_RECT.w / 2 - (LOUNGE_RECT.w * 0.46) / 2,
  y: LOUNGE_RECT.y + LOUNGE_RECT.h / 2 - (LOUNGE_RECT.h * 0.2) / 2,
  w: LOUNGE_RECT.w * 0.46,
  h: LOUNGE_RECT.h * 0.2,
};

// Impassable sub-tile props, checked by isSolid in addition to the SOLID tile
// kinds. Pixel rects so props that don't fill a whole tile still block.
const SOLID_RECTS: { x: number; y: number; w: number; h: number }[] = [LOUNGE_TABLE_RECT];

// Team-island (pod) footprints as [colStart, colEnd, rowStart, rowEnd], mirroring
// OPEN_DESKS. The renderer draws a soft accent rug under each so the desk clusters
// read as team neighbourhoods (Gather-like).
const PODS: [number, number, number, number][] = [
  [4, 5, 9, 10],
  [11, 12, 9, 10],
  [19, 20, 9, 10],
  [27, 28, 9, 10],
  [5, 6, 15, 16],
  [11, 12, 15, 16],
  [18, 20, 15, 16],
];

// Pixel rects for the pod rugs: the desk block plus a full one-tile border all
// around (so a 2×2 desk pod sits on a 4×4 rug).
export const POD_RUGS = PODS.map(([cs, ce, rs, re]) => ({
  x: (cs - 1) * TILE_SIZE + OFF_X,
  y: (rs - 1) * TILE_SIZE + OFF_Y,
  w: (ce - cs + 3) * TILE_SIZE,
  h: (re - rs + 3) * TILE_SIZE,
}));

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
    for (let rr = room.r + OUTDOOR_MARGIN; rr < room.r + room.h + OUTDOOR_MARGIN; rr++) {
      for (let cc = room.c + OUTDOOR_MARGIN; cc < room.c + room.w + OUTDOOR_MARGIN; cc++) {
        if (rr < 0 || rr >= MAP_ROWS || cc < 0 || cc >= MAP_COLS) continue;
        if (officeMap[rr][cc] === Tile.MEETING) grid[rr][cc] = idx;
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

  // The lounge is a conversation-restricted zone too (like the booths): an
  // isolated call bubble where everyone inside is connected and audio doesn't
  // leak out — but it has no walls, so its grid cells are the LOUNGE tiles.
  const loungeIdx = zones.length;
  for (let rr = LOUNGE.r + OUTDOOR_MARGIN; rr < LOUNGE.r + LOUNGE.h + OUTDOOR_MARGIN; rr++) {
    for (let cc = LOUNGE.c + OUTDOOR_MARGIN; cc < LOUNGE.c + LOUNGE.w + OUTDOOR_MARGIN; cc++) {
      if (rr < 0 || rr >= MAP_ROWS || cc < 0 || cc >= MAP_COLS) continue;
      if (officeMap[rr][cc] === Tile.LOUNGE) grid[rr][cc] = loungeIdx;
    }
  }
  zones.push({
    id: 'lounge',
    name: t('zone.lounge'),
    x: LOUNGE_RECT.x,
    y: LOUNGE_RECT.y,
    w: LOUNGE_RECT.w,
    h: LOUNGE_RECT.h,
  });

  return { zones, grid };
}

const { zones: zonesList, grid: zoneGrid } = buildZones();

export const ZONES: Zone[] = zonesList;

/** Return the zone containing pixel (px, py), or null when outside every zone. */
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
