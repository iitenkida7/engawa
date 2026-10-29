// Map data format (MapDef): the office layout as plain data, so a map can be
// swapped without code changes. It only PLACES parts — every part's look
// (desks, chairs, rugs, trees, the pond…) is drawn by the app (world/map-art.ts),
// and the only visual choices a map makes are picks from the app's palettes
// (FLOOR_PATTERNS / FLOOR_THEMES colour index).
//
// All coordinates are map-absolute tiles (col c, row r); a rect is its top-left
// tile plus its size in tiles. The world is built from it in the client's
// world/tilemap.ts.
//
// Shared by both packages (mounted at /maps next to each): the server loads and
// validates the configured map at boot and serves it (GET /api/map); the client
// builds its world from what it gets. Keep this file free of imports.

// Floor rug patterns the renderer can draw ('none' = a plain rug).
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

// Number of rug colour themes the app offers (the client's FLOOR_THEMES, which a
// client test pins to this): a FloorDef `color` is an index below it.
export const FLOOR_THEME_COUNT = 9;

// Pixels per tile, for both the client's world and the server's bounds/spawn.
export const TILE_SIZE = 50;

export type TilePos = [number, number];
export type TileRect = { c: number; r: number; w: number; h: number };

/** A rug look: one of FLOOR_PATTERNS + an index into FLOOR_THEMES. */
export type FloorDef = { pattern: FloorPattern; color: number };

/** Display name per UI language. */
export type NameDef = { ja: string; en: string };

/**
 * Room category. Every room is an isolated call zone; the kind only picks the
 * details: 'meeting' rooms get a whiteboard + cabinet and start SFU cameras on
 * the lowest simulcast layer (and count for the recording reminder).
 */
export type RoomKind = 'exec' | 'meeting' | 'oneonone' | 'booth';

export type MapDef = {
  version: 1;
  // Map size in tiles. Everything not stamped below is outdoor grass.
  cols: number;
  rows: number;
  // Buildings: a floor rect enclosed by a one-tile outer wall (inside the rect),
  // with `doors` opening wall tiles back to floor.
  buildings: (TileRect & { doors: TilePos[] })[];
  // Walled rooms (call zones): the rect is the INTERIOR — the wall ring is
  // stamped just outside it. `doors` open wall tiles; `table` is the solid
  // meeting-table footprint, drawn with chairs around it.
  rooms: (TileRect & {
    id: string;
    kind: RoomKind;
    name: NameDef;
    doors: TilePos[];
    table: TileRect;
    floor?: FloorDef;
  })[];
  // Desk units: a 3-tile desk centred on (c,r) with one chair in front of it —
  // above when facing 'south', below when facing 'north'. With `rug`, it gets
  // its own 3×3 pod rug around the chair.
  desks: { c: number; r: number; facing: 'south' | 'north'; rug?: FloorDef }[];
  // Shared rugs that put everyone on them in one call, without being a room.
  teamAreas: (TileRect & { id: string; floor?: FloorDef })[];
  // Wall-less café call zones: a rug with armchairs around a coffee table.
  lounges: (TileRect & { id: string; name: NameDef; floor?: FloorDef })[];
  plants: TilePos[];
  ponds: TileRect[];
  // size 1 = a small tree, 2 = a big 2×2 tree; variant picks its look (0/1).
  trees: { c: number; r: number; size: 1 | 2; variant: 0 | 1 }[];
  // Where newcomers appear (the client snaps it to the nearest walkable tile).
  // Defaults to the first building's floor, or the whole map without one.
  spawn?: TileRect;
};

// Patterns a map may ask for: the drawn ones plus 'none' (a plain rug).
const PATTERNS = new Set<string>([...FLOOR_PATTERNS, 'none']);
const MAP_KEYS = [
  'buildings',
  'rooms',
  'desks',
  'teamAreas',
  'lounges',
  'plants',
  'ponds',
  'trees',
] as const;
const ROOM_KINDS = new Set<string>(['exec', 'meeting', 'oneonone', 'booth'] satisfies RoomKind[]);

function deepFreeze<T>(v: T): T {
  if (v && typeof v === 'object') for (const child of Object.values(v)) deepFreeze(child);
  return Object.freeze(v);
}

/**
 * Check a map before the world is built from it, and freeze it.
 *
 * A map is data — hand-authored and swappable — so the TypeScript types above
 * say nothing about the JSON that actually loads. A typo has to fail here, by
 * name, rather than as an `undefined` deep inside the renderer: an out-of-range
 * `color` used to blank the whole canvas, and a door written `[8]` used to
 * silently leave a room with no way in. Shape, bounds, and the placement
 * mistakes that would otherwise fail silently (duplicate zone ids, doors off
 * their wall or covered by something solid, a table outside its room, a tree
 * off the open grass). It does not judge the layout beyond that.
 *
 * The input is untyped (`unknown`): it is whatever JSON was loaded.
 *
 * Freezing makes the derived lookups safe to hand out by reference: every
 * FloorStyle the app reads (a room's rug, a desk's pod rug) IS the object in
 * this JSON, shared by every caller, so a stray write would corrupt the map for
 * the rest of the session.
 */
export function assertMapDef(input: unknown): MapDef {
  const def = input as MapDef;
  const bad = (msg: string): never => {
    throw new Error(`invalid map data: ${msg}`);
  };
  if (!def || typeof def !== 'object') bad('not an object');
  if (def.version !== 1) bad(`unsupported version ${String(def.version)} (this build reads 1)`);
  const { cols, rows } = def;
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1)
    bad(`cols/rows must be positive integers (got ${String(cols)}x${String(rows)})`);
  for (const key of MAP_KEYS) if (!Array.isArray(def[key])) bad(`'${key}' must be an array`);

  const obj = (where: string, v: unknown): void => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) bad(`${where}: missing or not an object`);
  };
  const inBounds = (c: number, r: number): boolean => c >= 0 && c < cols && r >= 0 && r < rows;
  const pos = (where: string, p: TilePos): void => {
    if (!Array.isArray(p) || p.length !== 2 || !p.every((n) => Number.isInteger(n)))
      bad(`${where}: a tile position must be [col, row] (got ${JSON.stringify(p)})`);
    if (!inBounds(p[0], p[1])) bad(`${where}: tile ${JSON.stringify(p)} is outside the map`);
  };
  // `margin` is the ring stamped around the rect (a room's walls), which has to
  // fit on the map too.
  const rect = (where: string, t: TileRect, margin = 0): void => {
    obj(where, t);
    if (!Number.isInteger(t.c) || !Number.isInteger(t.r))
      bad(`${where}: position must be whole tiles (got ${t.c},${t.r})`);
    if (!Number.isInteger(t.w) || !Number.isInteger(t.h) || t.w < 1 || t.h < 1)
      bad(`${where}: size must be whole tiles, at least 1x1 (got ${t.w}x${t.h})`);
    if (
      !inBounds(t.c - margin, t.r - margin) ||
      !inBounds(t.c + t.w - 1 + margin, t.r + t.h - 1 + margin)
    )
      bad(`${where}: rect ${t.c},${t.r} ${t.w}x${t.h} runs outside the ${cols}x${rows} map`);
  };
  // A door has to open the ring of tiles just outside `t` (a room's wall ring;
  // a building's walls are its rect's own edge, so pass ring = 0). A door
  // anywhere else leaves the real wall solid — a room with no way in.
  const doors = (where: string, t: TileRect, list: TilePos[], ring: number): void => {
    if (!Array.isArray(list)) bad(`${where} doors: must be an array`);
    list.forEach((d, j) => {
      pos(`${where} door ${j}`, d);
      const [c, r] = d;
      const left = t.c - ring;
      const top = t.r - ring;
      const right = t.c + t.w - 1 + ring;
      const bottom = t.r + t.h - 1 + ring;
      const inside = c >= left && c <= right && r >= top && r <= bottom;
      if (!inside || (c !== left && c !== right && r !== top && r !== bottom))
        bad(`${where} door ${j}: tile ${JSON.stringify(d)} is not on its wall`);
    });
  };
  const floor = (where: string, f: FloorDef | undefined): void => {
    if (f === undefined) return;
    obj(`${where} floor`, f);
    if (!PATTERNS.has(f.pattern)) bad(`${where}: unknown floor pattern '${f.pattern}'`);
    const last = FLOOR_THEME_COUNT - 1;
    if (!Number.isInteger(f.color) || f.color < 0 || f.color > last)
      bad(`${where}: floor colour ${f.color} is outside 0..${last}`);
  };
  const name = (where: string, n: NameDef): void => {
    if (!n || typeof n.ja !== 'string' || typeof n.en !== 'string')
      bad(`${where}: name must be { ja, en } strings`);
  };
  // Zone ids are what the server groups calls by: two areas sharing one would
  // merge into a single call across their walls.
  const ids = new Set<string>();
  const id = (where: string, v: string): void => {
    if (typeof v !== 'string' || v === '') bad(`${where}: id must be a non-empty string`);
    if (ids.has(v)) bad(`${where}: id '${v}' is used twice`);
    ids.add(v);
  };

  def.buildings.forEach((b, i) => {
    rect(`buildings[${i}]`, b);
    doors(`buildings[${i}]`, b, b.doors, 0);
  });
  def.rooms.forEach((room, i) => {
    id(`rooms[${i}]`, room?.id);
    const at = `room '${room.id}'`;
    if (!ROOM_KINDS.has(room.kind)) bad(`${at}: unknown kind '${String(room.kind)}'`);
    name(at, room.name);
    rect(at, room, 1); // + its wall ring
    doors(at, room, room.doors, 1);
    rect(`${at} table`, room.table);
    const t = room.table;
    if (t.c < room.c || t.r < room.r || t.c + t.w > room.c + room.w || t.r + t.h > room.r + room.h)
      bad(`${at} table: must sit inside the room`);
    floor(at, room.floor);
  });
  def.desks.forEach((u, i) => {
    obj(`desks[${i}]`, u);
    if (u.facing !== 'south' && u.facing !== 'north')
      bad(`desks[${i}]: facing must be 'south' or 'north' (got ${JSON.stringify(u.facing)})`);
    rect(`desks[${i}]`, { c: u.c - 1, r: u.r, w: 3, h: 1 }); // the 3-tile desk
    const chairRow = u.r + (u.facing === 'south' ? -1 : 1);
    pos(`desks[${i}] chair`, [u.c, chairRow]);
    if (u.rug !== undefined) rect(`desks[${i}] rug`, { c: u.c - 1, r: chairRow - 1, w: 3, h: 3 });
    floor(`desks[${i}]`, u.rug);
  });
  def.teamAreas.forEach((a, i) => {
    id(`teamAreas[${i}]`, a?.id);
    rect(`teamArea '${a.id}'`, a);
    floor(`teamArea '${a.id}'`, a.floor);
  });
  def.lounges.forEach((lo, i) => {
    id(`lounges[${i}]`, lo?.id);
    name(`lounge '${lo.id}'`, lo.name);
    rect(`lounge '${lo.id}'`, lo);
    floor(`lounge '${lo.id}'`, lo.floor);
  });
  def.plants.forEach((p, i) => {
    pos(`plants[${i}]`, p);
  });
  def.ponds.forEach((p, i) => {
    rect(`ponds[${i}]`, p);
  });
  def.trees.forEach((t, i) => {
    obj(`trees[${i}]`, t);
    if (t.size !== 1 && t.size !== 2) bad(`trees[${i}]: size must be 1 or 2 (got ${t.size})`);
    if (t.variant !== 0 && t.variant !== 1)
      bad(`trees[${i}]: variant must be 0 or 1 (got ${JSON.stringify(t.variant)})`);
    rect(`trees[${i}]`, { c: t.c, r: t.r, w: t.size, h: t.size });
  });
  if (def.spawn !== undefined) rect('spawn', def.spawn);

  // ── Placement: the mistakes that load fine but break the map ──
  // Stamped in the client's grid order (world/tilemap.ts buildOfficeMap): a
  // solid part on a doorway seals it, and trees go down last, so one dropped on
  // anything but open grass would overwrite it.
  const key = (c: number, r: number): number => r * cols + c;
  const tiles = (t: TileRect): number[] => {
    const out: number[] = [];
    for (let r = t.r; r < t.r + t.h; r++) for (let c = t.c; c < t.c + t.w; c++) out.push(key(c, r));
    return out;
  };
  const ring = (t: TileRect): number[] => {
    const outer = { c: t.c - 1, r: t.r - 1, w: t.w + 2, h: t.h + 2 };
    const inner = new Set(tiles(t));
    return tiles(outer).filter((k) => !inner.has(k));
  };
  // Every door tile → who it belongs to. A door is only opened when its own
  // room is stamped, so another room's wall laid over it later seals it again.
  const doorOf = new Map<number, string>();
  def.buildings.forEach((b, i) => {
    for (const [c, r] of b.doors) doorOf.set(key(c, r), `buildings[${i}]`);
  });
  for (const room of def.rooms)
    for (const [c, r] of room.doors) doorOf.set(key(c, r), `room '${room.id}'`);
  const blocks = (what: string, ks: number[], owner?: string): void => {
    for (const k of ks) {
      const door = doorOf.get(k);
      if (door !== undefined && door !== owner)
        bad(`${what} covers a door of ${door} at [${k % cols},${Math.floor(k / cols)}]`);
    }
  };
  const built = new Set<number>(); // tiles that are no longer open grass
  const build = (ks: number[]): void => {
    for (const k of ks) built.add(k);
  };
  for (const b of def.buildings) build(tiles(b));
  for (const room of def.rooms) {
    blocks(`room '${room.id}' wall`, ring(room), `room '${room.id}'`);
    build(ring(room));
    build(tiles(room));
  }
  for (const lo of def.lounges) build(tiles(lo));
  def.desks.forEach((u, i) => {
    const desk = tiles({ c: u.c - 1, r: u.r, w: 3, h: 1 });
    blocks(`desks[${i}]`, desk);
    build(desk);
  });
  def.plants.forEach(([c, r], i) => {
    blocks(`plants[${i}]`, [key(c, r)]);
    build([key(c, r)]);
  });
  def.ponds.forEach((p, i) => {
    blocks(`ponds[${i}]`, tiles(p));
    build(tiles(p));
  });
  def.trees.forEach((t, i) => {
    const ks = tiles({ c: t.c, r: t.r, w: t.size, h: t.size });
    if (ks.some((k) => built.has(k))) bad(`trees[${i}] at ${t.c},${t.r} is not on open grass`);
    build(ks);
  });
  // Newcomers appear anywhere in the spawn area, so it must stay out of the
  // rooms: a room is an always-on call zone, and landing in one drops you into
  // a stranger's meeting the moment you join. The default area is a whole
  // building floor, rooms included, so a map with rooms has to name its spawn.
  const spawnTiles = new Set(tiles(spawnArea(def)));
  for (const room of def.rooms)
    if (tiles(room).some((k) => spawnTiles.has(k)))
      bad(
        def.spawn
          ? `spawn overlaps room '${room.id}'`
          : `the default spawn area covers room '${room.id}': give the map a spawn`,
      );
  return deepFreeze(def);
}

/** Where newcomers appear: the map's `spawn`, else the first building's floor
 * (inside its walls), else the whole map. */
export function spawnArea(def: MapDef): TileRect {
  if (def.spawn) return def.spawn;
  const [b] = def.buildings;
  if (b && b.w > 2 && b.h > 2) return { c: b.c + 1, r: b.r + 1, w: b.w - 2, h: b.h - 2 };
  return { c: 0, r: 0, w: def.cols, h: def.rows };
}
