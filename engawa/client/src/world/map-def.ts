// Map data format (MapDef): the office layout as plain data, so a map can be
// swapped without code changes. It only PLACES parts — every part's look
// (desks, chairs, rugs, trees, the pond…) is drawn by the app (world/map-art.ts),
// and the only visual choices a map makes are picks from the app's palettes
// (FLOOR_PATTERNS / FLOOR_THEMES colour index).
//
// All coordinates are map-absolute tiles (col c, row r); a rect is its top-left
// tile plus its size in tiles. The world is built from it in world/tilemap.ts.

import { CAFE_COLOR, FLOOR_PATTERNS, type FloorPattern } from '@/world/floor-styles';

export type TilePos = [number, number];
export type TileRect = { c: number; r: number; w: number; h: number };

/** A rug look: one of FLOOR_PATTERNS + a colour theme index (CAFE_COLOR = red). */
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
};

// Patterns a map may ask for: the drawn ones plus 'none' (a plain rug).
const PATTERNS = new Set<string>([...FLOOR_PATTERNS, 'none']);

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
 * silently leave a room with no way in. Shape and bounds only — it does not
 * judge the layout.
 *
 * Freezing makes the derived lookups safe to hand out by reference: every
 * FloorStyle the app reads (a room's rug, a desk's pod rug) IS the object in
 * this JSON, shared by every caller, so a stray write would corrupt the map for
 * the rest of the session.
 */
export function assertMapDef(def: MapDef): MapDef {
  const bad = (msg: string): never => {
    throw new Error(`invalid map data: ${msg}`);
  };
  if (def.version !== 1) bad(`unsupported version ${String(def.version)} (this build reads 1)`);
  const { cols, rows } = def;
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1)
    bad(`cols/rows must be positive integers (got ${String(cols)}x${String(rows)})`);

  const inBounds = (c: number, r: number): boolean => c >= 0 && c < cols && r >= 0 && r < rows;
  const pos = (where: string, p: TilePos): void => {
    if (!Array.isArray(p) || p.length !== 2 || !p.every((n) => Number.isInteger(n)))
      bad(`${where}: a tile position must be [col, row] (got ${JSON.stringify(p)})`);
    if (!inBounds(p[0], p[1])) bad(`${where}: tile ${JSON.stringify(p)} is outside the map`);
  };
  // `margin` is the ring stamped around the rect (a room's walls), which has to
  // fit on the map too.
  const rect = (where: string, t: TileRect, margin = 0): void => {
    if (!Number.isInteger(t.w) || !Number.isInteger(t.h) || t.w < 1 || t.h < 1)
      bad(`${where}: size must be whole tiles, at least 1x1 (got ${t.w}x${t.h})`);
    if (
      !inBounds(t.c - margin, t.r - margin) ||
      !inBounds(t.c + t.w - 1 + margin, t.r + t.h - 1 + margin)
    )
      bad(`${where}: rect ${t.c},${t.r} ${t.w}x${t.h} runs outside the ${cols}x${rows} map`);
  };
  const floor = (where: string, f: FloorDef | undefined): void => {
    if (!f) return;
    if (!PATTERNS.has(f.pattern)) bad(`${where}: unknown floor pattern '${f.pattern}'`);
    if (!Number.isInteger(f.color) || f.color < 0 || f.color > CAFE_COLOR)
      bad(`${where}: floor colour ${f.color} is outside 0..${CAFE_COLOR}`);
  };

  def.buildings.forEach((b, i) => {
    rect(`buildings[${i}]`, b);
    b.doors.forEach((d, j) => {
      pos(`buildings[${i}].doors[${j}]`, d);
    });
  });
  for (const room of def.rooms) {
    rect(`room '${room.id}'`, room, 1); // + its wall ring
    room.doors.forEach((d, j) => {
      pos(`room '${room.id}' door ${j}`, d);
    });
    rect(`room '${room.id}' table`, room.table);
    floor(`room '${room.id}'`, room.floor);
  }
  def.desks.forEach((u, i) => {
    rect(`desks[${i}]`, { c: u.c - 1, r: u.r, w: 3, h: 1 }); // the 3-tile desk
    const chairRow = u.r + (u.facing === 'south' ? -1 : 1);
    pos(`desks[${i}] chair`, [u.c, chairRow]);
    if (u.rug) rect(`desks[${i}] rug`, { c: u.c - 1, r: chairRow - 1, w: 3, h: 3 });
    floor(`desks[${i}]`, u.rug);
  });
  for (const a of def.teamAreas) {
    rect(`teamArea '${a.id}'`, a);
    floor(`teamArea '${a.id}'`, a.floor);
  }
  for (const lo of def.lounges) {
    rect(`lounge '${lo.id}'`, lo);
    floor(`lounge '${lo.id}'`, lo.floor);
  }
  def.plants.forEach((p, i) => {
    pos(`plants[${i}]`, p);
  });
  def.ponds.forEach((p, i) => {
    rect(`ponds[${i}]`, p);
  });
  def.trees.forEach((t, i) => {
    if (t.size !== 1 && t.size !== 2) bad(`trees[${i}]: size must be 1 or 2 (got ${t.size})`);
    rect(`trees[${i}]`, { c: t.c, r: t.r, w: t.size, h: t.size });
  });
  return deepFreeze(def);
}
