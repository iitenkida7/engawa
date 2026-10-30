// Chairs, benches and plants that users place on the map themselves. The server
// keeps the shared list (memory only, server/src/items.ts); this holds our copy,
// says whether a tile may take an item, draws them, and tells the renderer where
// someone is sitting in one.

import type { ItemFacing, ItemKind, PlacedItem } from '@/core/types';
import { drawPlant, PALETTE, roundRect } from '@/world/map-art';
import {
  isSolid,
  MAP_COLS,
  MAP_ROWS,
  officeMap,
  type Seat,
  SOLID,
  seatAt,
  TILE_SIZE,
} from '@/world/tilemap';

export const ITEM_KINDS: ItemKind[] = ['chair', 'bench', 'plant'];
export const ITEM_FACINGS: ItemFacing[] = ['down', 'right', 'up', 'left'];

// Chairs and benches are sat on; a plant is just decoration.
export function isSeatKind(kind: ItemKind): boolean {
  return kind === 'chair' || kind === 'bench';
}

// The next facing in a quarter turn (the rotate button / R key).
export function rotateFacing(f: ItemFacing): ItemFacing {
  return ITEM_FACINGS[(ITEM_FACINGS.indexOf(f) + 1) % ITEM_FACINGS.length];
}

export class PlacedItemStore {
  private items = new Map<string, PlacedItem>();
  // Bumped on every change, so the renderer's idle-frame skip notices them.
  version = 0;

  set(list: PlacedItem[]) {
    this.items.clear();
    for (const it of list) this.items.set(it.id, it);
    this.version++;
  }
  add(item: PlacedItem) {
    this.items.set(item.id, item);
    this.version++;
  }
  remove(id: string) {
    if (this.items.delete(id)) this.version++;
  }
  all(): PlacedItem[] {
    return [...this.items.values()];
  }
  at(col: number, row: number): PlacedItem | undefined {
    for (const it of this.items.values()) if (it.col === col && it.row === row) return it;
    return undefined;
  }
}

// The one shared copy (the renderer and the seat lookup both read it).
export const placedItems = new PlacedItemStore();

/**
 * Whether an item may go on this tile: inside the map, on floor you can stand on
 * (not a wall, desk, tree, pond or table), not already a sitting spot of the
 * map's own (a desk chair, a café armchair) and not already holding an item.
 */
export function canPlaceAt(col: number, row: number, store: PlacedItemStore = placedItems) {
  if (col < 0 || col >= MAP_COLS || row < 0 || row >= MAP_ROWS) return false;
  if (SOLID.has(officeMap[row][col])) return false;
  const cx = col * TILE_SIZE + TILE_SIZE / 2;
  const cy = row * TILE_SIZE + TILE_SIZE / 2;
  if (isSolid(cx, cy)) return false;
  if (seatAt(cx, cy)) return false;
  return store.at(col, row) === undefined;
}

/** The seat for someone standing on a placed chair or bench, else null. */
export function placedSeatAt(
  px: number,
  py: number,
  store: PlacedItemStore = placedItems,
): Seat | null {
  const it = store.at(Math.floor(px / TILE_SIZE), Math.floor(py / TILE_SIZE));
  if (!it || !isSeatKind(it.kind)) return null;
  // Centred on the tile like a café armchair: no lift.
  return { facing: it.facing, lift: 0 };
}

// A seat with its backrest on the side away from where the sitter faces.
function drawSeat(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  facing: ItemFacing,
  w: number,
  h: number,
) {
  const back = 6;
  ctx.fillStyle = PALETTE.chair;
  roundRect(ctx, x - w / 2, y - h / 2, w, h, 4);
  ctx.fill();
  ctx.fillStyle = PALETTE.chairBack;
  switch (facing) {
    case 'down':
      roundRect(ctx, x - w / 2, y - h / 2, w, back, 3);
      break;
    case 'up':
      roundRect(ctx, x - w / 2, y + h / 2 - back, w, back, 3);
      break;
    case 'right':
      roundRect(ctx, x - w / 2, y - h / 2, back, h, 3);
      break;
    case 'left':
      roundRect(ctx, x + w / 2 - back, y - h / 2, back, h, 3);
      break;
  }
  ctx.fill();
}

/** Draw one item on its tile (world coordinates). */
export function drawPlacedItem(
  ctx: CanvasRenderingContext2D,
  item: Pick<PlacedItem, 'kind' | 'col' | 'row' | 'facing'>,
  alpha = 1,
) {
  const x = item.col * TILE_SIZE;
  const y = item.row * TILE_SIZE;
  const cx = x + TILE_SIZE / 2;
  const cy = y + TILE_SIZE / 2;
  const prev = ctx.globalAlpha;
  ctx.globalAlpha = prev * alpha;
  if (item.kind === 'plant') {
    drawPlant(ctx, x, y);
  } else if (item.kind === 'chair') {
    drawSeat(ctx, cx, cy, item.facing, 26, 26);
  } else {
    // A bench is a long seat: wide across the way it faces.
    const vertical = item.facing === 'left' || item.facing === 'right';
    drawSeat(ctx, cx, cy, item.facing, vertical ? 24 : 42, vertical ? 42 : 24);
  }
  ctx.globalAlpha = prev;
}
