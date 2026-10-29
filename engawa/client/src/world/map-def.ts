// Map data format (MapDef): the office layout as plain data, so a map can be
// swapped without code changes. It only PLACES parts — every part's look
// (desks, chairs, rugs, trees, the pond…) is drawn by the app (world/map-art.ts),
// and the only visual choices a map makes are picks from the app's palettes
// (FLOOR_PATTERNS / FLOOR_THEMES colour index).
//
// All coordinates are map-absolute tiles (col c, row r); a rect is its top-left
// tile plus its size in tiles. The world is built from it in world/tilemap.ts.

import type { FloorPattern } from '@/world/floor-styles';

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
