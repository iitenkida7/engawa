export const TILE_SIZE = 50;
export const MAP_COLS = 40;
export const MAP_ROWS = 30;

export const Tile = {
  FLOOR: 0,
  WALL: 1,
  DESK: 2,
  MEETING: 3,
  LOUNGE: 4,
  PLANT: 5,
} as const;

export const SOLID = new Set<number>([Tile.WALL, Tile.DESK, Tile.PLANT]);

export const TILE_FILL: Record<number, string> = {
  [Tile.FLOOR]: '#2e3440',
  [Tile.WALL]: '#1a1d24',
  [Tile.DESK]: '#6b5332',
  [Tile.MEETING]: '#2a3445',
  [Tile.LOUNGE]: '#3d3028',
  [Tile.PLANT]: '#2d5a35',
};

export const TILE_BORDER: Record<number, string> = {
  [Tile.WALL]: '#252830',
  [Tile.DESK]: '#55412a',
  [Tile.PLANT]: '#1e4425',
};

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

  // ── Outer walls ──
  fill(0, 0, MAP_COLS, 1, Tile.WALL);
  fill(0, MAP_ROWS - 1, MAP_COLS, 1, Tile.WALL);
  fill(0, 0, 1, MAP_ROWS, Tile.WALL);
  fill(MAP_COLS - 1, 0, 1, MAP_ROWS, Tile.WALL);

  // ── Top section (rows 1-4): offices + lounge ──

  // Office 1 (cols 1-6)
  fill(7, 0, 1, 6, Tile.WALL);
  fill(0, 5, 8, 1, Tile.WALL);
  m[5][3] = Tile.FLOOR;
  m[5][4] = Tile.FLOOR;
  fill(3, 2, 2, 2, Tile.DESK);

  // Office 2 (cols 8-13)
  fill(14, 0, 1, 6, Tile.WALL);
  fill(8, 5, 7, 1, Tile.WALL);
  m[5][10] = Tile.FLOOR;
  m[5][11] = Tile.FLOOR;
  fill(10, 2, 2, 2, Tile.DESK);

  // Lounge (cols 29-38)
  fill(28, 0, 1, 6, Tile.WALL);
  fill(28, 5, 12, 1, Tile.WALL);
  m[5][32] = Tile.FLOOR;
  m[5][33] = Tile.FLOOR;
  fill(29, 1, 10, 4, Tile.LOUNGE);
  fill(31, 2, 4, 1, Tile.DESK);
  m[2][37] = Tile.PLANT;

  // ── Open office area (rows 6-22): desk clusters ──
  const deskCols = [
    [2, 3],
    [5, 6],
    [11, 12],
    [14, 15],
    [24, 25],
    [27, 28],
    [33, 34],
    [36, 37],
  ];
  const deskRows = [7, 9, 13, 15, 19, 21];
  for (const row of deskRows) {
    for (const [c1, c2] of deskCols) {
      m[row][c1] = Tile.DESK;
      m[row][c2] = Tile.DESK;
    }
  }

  // Plants along center aisle and edges
  m[10][1] = Tile.PLANT;
  m[10][19] = Tile.PLANT;
  m[10][20] = Tile.PLANT;
  m[10][38] = Tile.PLANT;
  m[16][1] = Tile.PLANT;
  m[16][19] = Tile.PLANT;
  m[16][20] = Tile.PLANT;
  m[16][38] = Tile.PLANT;

  // ── Bottom section (rows 23-28): meeting rooms ──
  fill(0, 23, MAP_COLS, 1, Tile.WALL);
  m[23][5] = Tile.FLOOR;
  m[23][6] = Tile.FLOOR;
  m[23][19] = Tile.FLOOR;
  m[23][20] = Tile.FLOOR;
  m[23][33] = Tile.FLOOR;
  m[23][34] = Tile.FLOOR;

  // Meeting room 1 (cols 1-12)
  fill(13, 23, 1, 7, Tile.WALL);
  fill(1, 24, 12, 5, Tile.MEETING);
  fill(4, 25, 5, 3, Tile.DESK);

  // Meeting room 2 (cols 27-38)
  fill(26, 23, 1, 7, Tile.WALL);
  fill(27, 24, 12, 5, Tile.MEETING);
  fill(30, 25, 5, 3, Tile.DESK);

  return m;
}

export const officeMap = buildOfficeMap();

/** Find the nearest walkable pixel position, snapping to tile centers. */
export function findWalkableSpawn(px: number, py: number, radius: number): { x: number; y: number } {
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
