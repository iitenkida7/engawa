// Pure decoration mapping for the map renderer: classifies each tile cell into a
// floor kind / prop. Kept free of DOM / asset imports so the placement logic is
// unit-testable; canvas.ts uses these to draw the map procedurally. Decoration is
// purely visual — it never touches SOLID/collision (that stays in tilemap.ts).

import { officeMap, TILE_SIZE, Tile, ZONES } from '@/world/tilemap';

export type FloorKind = 'wood' | 'carpet' | 'lounge';

// Meeting rooms read as carpet; the lounge reads as its own rug; the open office
// reads as wood. Rooms are tested against the zone's bounding RECT, not per-tile
// zone membership, so a desk/plant punched into a room (which isn't itself a
// MEETING tile, so zoneAt would miss it) still gets the room's carpet underneath
// it. The lounge is an open area (no zone), so it's keyed off the LOUNGE tile.
export function floorKindAt(col: number, row: number): FloorKind {
  if (row >= 0 && row < officeMap.length && col >= 0 && col < officeMap[row].length) {
    if (officeMap[row][col] === Tile.LOUNGE) return 'lounge';
  }
  const cx = col * TILE_SIZE + TILE_SIZE / 2;
  const cy = row * TILE_SIZE + TILE_SIZE / 2;
  for (const z of ZONES) {
    if (cx >= z.x && cx < z.x + z.w && cy >= z.y && cy < z.y + z.h) return 'carpet';
  }
  return 'wood';
}

// Room category for colour-coding the floor (Gather-like, so each kind of room
// reads at a glance). Derived from the zone id; null = open office.
export type RoomKind = 'exec' | 'meeting' | 'oneonone' | 'booth' | 'lounge';

export function roomKindAt(col: number, row: number): RoomKind | null {
  const cx = col * TILE_SIZE + TILE_SIZE / 2;
  const cy = row * TILE_SIZE + TILE_SIZE / 2;
  for (const z of ZONES) {
    if (cx < z.x || cx >= z.x + z.w || cy < z.y || cy >= z.y + z.h) continue;
    if (z.id === 'ceo') return 'exec';
    if (z.id === 'lounge' || z.id.startsWith('cafe')) return 'lounge';
    if (z.id.startsWith('1on1')) return 'oneonone';
    if (z.id.startsWith('booth')) return 'booth';
    return 'meeting'; // all-hands + meeting-N
  }
  return null;
}

export type Prop = 'desk' | 'plant' | null;

// The decorative prop drawn on top of the floor for a given tile, if any.
export function propFor(tile: number): Prop {
  if (tile === Tile.DESK) return 'desk';
  if (tile === Tile.PLANT) return 'plant';
  return null;
}
