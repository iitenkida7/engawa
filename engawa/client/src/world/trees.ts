// Outdoor tree scatter (#229), split out of tilemap.ts.

// One tree on the grounds: its top-left pixel and tile span (1 = small, 2 = a big
// 2×2 tree). The renderer draws from this list; its footprint tiles are stamped
// TREE in officeMap for collision (#229).
export type Tree = { x: number; y: number; tiles: number; variant: number };

type TileRect = { c: number; r: number; w: number; h: number };

// Everything placeTrees needs from the map, passed in (rather than imported from
// tilemap.ts) so this module doesn't import its caller. Room rects are
// building-local and the pond is in map coords, exactly as tilemap.ts has them.
export type TreeLayout = {
  tileSize: number;
  mapCols: number;
  mapRows: number;
  colOff: number;
  rowOff: number;
  buildingC0: number;
  buildingCols: number;
  buildingRows: number;
  gateRow: number; // building-local row of the side gates (GATE_R)
  rooms: TileRect[];
  pond: TileRect;
  grass: number; // Tile.GRASS
  tree: number; // Tile.TREE
};

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
export function placeTrees(m: number[][], layout: TreeLayout): Tree[] {
  const {
    tileSize: TILE_SIZE,
    mapCols: MAP_COLS,
    mapRows: MAP_ROWS,
    colOff: COL_OFF,
    rowOff: ROW_OFF,
    buildingC0: BUILDING_C0,
    buildingCols: BUILDING_COLS,
    buildingRows: BUILDING_ROWS,
    gateRow: GATE_R,
    rooms: ROOMS,
    pond: POND,
    grass: GRASS,
    tree: TREE,
  } = layout;
  const rng = mulberry32(0x5eed);
  const trees: Tree[] = [];
  const buildingBottom = ROW_OFF + BUILDING_ROWS;
  const buildingLeft = COL_OFF + BUILDING_C0; // last grass col on the left, +1
  const buildingRight = buildingLeft + BUILDING_COLS; // first grass col on the right

  const allGrass = (c: number, r: number, span: number): boolean => {
    for (let rr = r; rr < r + span; rr++)
      for (let cc = c; cc < c + span; cc++) {
        if (rr < 0 || rr >= MAP_ROWS || cc < 0 || cc >= MAP_COLS) return false;
        if (m[rr][cc] !== GRASS) return false;
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
    for (let rr = r; rr < r + tiles; rr++) for (let cc = c; cc < c + tiles; cc++) m[rr][cc] = TREE;
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
