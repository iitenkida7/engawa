export const TILE_SIZE = 50;
// A compact floor (1700×1200) keeps walking short. Must stay in sync with
// MAP_WIDTH/MAP_HEIGHT (client core/types.ts and server logic.ts).
export const MAP_COLS = 34;
export const MAP_ROWS = 24;

export const Tile = {
  FLOOR: 0,
  WALL: 1,
  DESK: 2,
  MEETING: 3,
  LOUNGE: 4,
  PLANT: 5,
} as const;

export const SOLID = new Set<number>([Tile.WALL, Tile.DESK, Tile.PLANT]);

// Tile colours live with the renderer (world/canvas.ts PALETTE), which draws the
// map procedurally. tilemap.ts stays pure layout + collision.

export function isSolid(px: number, py: number): boolean {
  const col = Math.floor(px / TILE_SIZE);
  const row = Math.floor(py / TILE_SIZE);
  if (col < 0 || col >= MAP_COLS || row < 0 || row >= MAP_ROWS) return true;
  return SOLID.has(officeMap[row][col]);
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
    name: '社長室',
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
    name: '大会議室',
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
    name: '会議室1',
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
    name: '会議室2',
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
    name: '会議室3',
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
  // ── Bottom strip (rows 20-22): three 1-on-1 rooms + three negotiation booths.
  {
    id: '1on1-1',
    name: '1on1ルーム1',
    c: 1,
    r: 20,
    w: 4,
    h: 3,
    doors: [
      [2, 19],
      [3, 19],
    ],
    desks: [[2, 21]],
  },
  {
    id: '1on1-2',
    name: '1on1ルーム2',
    c: 6,
    r: 20,
    w: 4,
    h: 3,
    doors: [
      [7, 19],
      [8, 19],
    ],
    desks: [[7, 21]],
  },
  {
    id: '1on1-3',
    name: '1on1ルーム3',
    c: 11,
    r: 20,
    w: 4,
    h: 3,
    doors: [
      [12, 19],
      [13, 19],
    ],
    desks: [[12, 21]],
  },
  {
    id: 'booth-1',
    name: '商談ブース1',
    c: 16,
    r: 20,
    w: 5,
    h: 3,
    doors: [
      [18, 19],
      [19, 19],
    ],
    desks: [
      [18, 21],
      [19, 21],
    ],
  },
  {
    id: 'booth-2',
    name: '商談ブース2',
    c: 22,
    r: 20,
    w: 5,
    h: 3,
    doors: [
      [24, 19],
      [25, 19],
    ],
    desks: [
      [24, 21],
      [25, 21],
    ],
  },
  {
    id: 'booth-3',
    name: '商談ブース3',
    c: 28,
    r: 20,
    w: 5,
    h: 3,
    doors: [
      [30, 19],
      [31, 19],
    ],
    desks: [
      [30, 21],
      [31, 21],
    ],
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
    x: minC * TILE_SIZE,
    y: minR * TILE_SIZE,
    w: (maxC - minC + 1) * TILE_SIZE,
    h: (maxR - minR + 1) * TILE_SIZE,
    ix: room.c * TILE_SIZE,
    iy: room.r * TILE_SIZE,
    iw: room.w * TILE_SIZE,
    ih: room.h * TILE_SIZE,
  };
});

// 25 open-office seats: four 2-desk benches per row across three rows (24) plus
// one extra → 25, matching a ~25-person team.
const OPEN_DESKS: [number, number][] = [
  [5, 8],
  [6, 8],
  [12, 8],
  [13, 8],
  [19, 8],
  [20, 8],
  [26, 8],
  [27, 8],
  [5, 11],
  [6, 11],
  [12, 11],
  [13, 11],
  [19, 11],
  [20, 11],
  [26, 11],
  [27, 11],
  [5, 14],
  [6, 14],
  [12, 14],
  [13, 14],
  [19, 14],
  [20, 14],
  [26, 14],
  [27, 14],
  [16, 11],
];

// A little greenery down the open floor's sides and center.
const OPEN_PLANTS: [number, number][] = [
  [2, 9],
  [31, 9],
  [2, 16],
  [31, 16],
  [16, 17],
];

function buildOfficeMap(): number[][] {
  const m: number[][] = [];
  for (let r = 0; r < MAP_ROWS; r++) {
    m.push(new Array(MAP_COLS).fill(Tile.FLOOR));
  }

  const fill = (c: number, r: number, w: number, h: number, t: number) => {
    for (let rr = r; rr < r + h; rr++)
      for (let cc = c; cc < c + w; cc++)
        if (rr >= 0 && rr < MAP_ROWS && cc >= 0 && cc < MAP_COLS) m[rr][cc] = t;
  };
  const set = (c: number, r: number, t: number) => {
    if (r >= 0 && r < MAP_ROWS && c >= 0 && c < MAP_COLS) m[r][c] = t;
  };

  // ── Outer walls ──
  fill(0, 0, MAP_COLS, 1, Tile.WALL);
  fill(0, MAP_ROWS - 1, MAP_COLS, 1, Tile.WALL);
  fill(0, 0, 1, MAP_ROWS, Tile.WALL);
  fill(MAP_COLS - 1, 0, 1, MAP_ROWS, Tile.WALL);

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

  // ── Open office: ~25 seats + greenery ──
  for (const [c, r] of OPEN_DESKS) set(c, r, Tile.DESK);
  for (const [c, r] of OPEN_PLANTS) set(c, r, Tile.PLANT);

  return m;
}

export const officeMap = buildOfficeMap();

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
    for (let rr = room.r; rr < room.r + room.h; rr++) {
      for (let cc = room.c; cc < room.c + room.w; cc++) {
        if (rr < 0 || rr >= MAP_ROWS || cc < 0 || cc >= MAP_COLS) continue;
        if (officeMap[rr][cc] === Tile.MEETING) grid[rr][cc] = idx;
      }
    }
    return {
      id: room.id,
      name: room.name,
      x: room.c * TILE_SIZE,
      y: room.r * TILE_SIZE,
      w: room.w * TILE_SIZE,
      h: room.h * TILE_SIZE,
    };
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
