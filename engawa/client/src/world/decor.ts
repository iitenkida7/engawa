// Pure decoration mapping for the map renderer: classifies a tile into the prop
// drawn on top of it. Kept free of DOM / asset imports so the mapping is
// unit-testable; map-art.ts uses it to draw the map procedurally. Decoration is
// purely visual — it never touches SOLID/collision (that stays in tilemap.ts).

import { Tile } from '@/world/tilemap';

export type Prop = 'desk' | 'plant' | null;

// The decorative prop drawn on top of the floor for a given tile, if any.
export function propFor(tile: number): Prop {
  if (tile === Tile.DESK) return 'desk';
  if (tile === Tile.PLANT) return 'plant';
  return null;
}
