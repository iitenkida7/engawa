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
export function islandId(k: number): string {
  return `island-${k}`;
}

// Everything computeFloorStyles needs from the map, passed in (rather than
// imported from tilemap.ts) so this module doesn't import its caller.
export type FloorStyleLayout = {
  rooms: { id: string; c: number; r: number; w: number }[];
  buildingC0: number;
  buildingCols: number;
  teamArea: { id: string; c: number };
  topIslandCols: number[];
  bottomIslandCols: number[];
  lounges: { id: string }[];
};

export function computeFloorStyles(layout: FloorStyleLayout): Map<string, FloorStyle> {
  const {
    rooms: ROOMS,
    buildingC0: BUILDING_C0,
    buildingCols: BUILDING_COLS,
    teamArea: TEAM_AREA,
    topIslandCols: TOP_ISLAND_COLS,
    bottomIslandCols: BOTTOM_ISLAND_COLS,
    lounges: LOUNGES,
  } = layout;
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
  const inBuilding = (r: FloorStyleLayout['rooms'][number]) =>
    r.c > BUILDING_C0 && r.c + r.w <= BUILDING_C0 + BUILDING_COLS - 1;
  const strip = (rooms: FloorStyleLayout['rooms']) => {
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
  // The team area differs from the island beside it and the ones above it.
  edge(TEAM_AREA.id, islandId(TOP_ISLAND_COLS.length + BOTTOM_ISLAND_COLS.length - 1));
  TOP_ISLAND_COLS.forEach((col, i) => {
    if (col + 1 >= TEAM_AREA.c) edge(TEAM_AREA.id, islandId(i));
  });
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
