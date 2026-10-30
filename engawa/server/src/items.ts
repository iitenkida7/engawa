// Placeable map items (chairs, benches, plants) that users put down themselves.
//
// Kept in memory only, like the rest of the signaling state (invariant #2): a
// server restart clears them. The server does not know the map's walls, so the
// client checks that a tile is free floor; here only the bounds, the kind, one
// item per tile and an overall cap are enforced, and ids are server-minted.

import { MAP_HEIGHT, MAP_WIDTH } from './logic';

// Must match the client's TILE_SIZE (world/tilemap.ts).
const ITEM_TILE_SIZE = 50;
export const ITEM_COLS = Math.floor(MAP_WIDTH / ITEM_TILE_SIZE);
export const ITEM_ROWS = Math.floor(MAP_HEIGHT / ITEM_TILE_SIZE);

export const ITEM_KINDS = ['chair', 'bench', 'plant'] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];
export const ITEM_FACINGS = ['up', 'down', 'left', 'right'] as const;
export type ItemFacing = (typeof ITEM_FACINGS)[number];

// Upper bound on items in the space, so a runaway client can't fill the map.
export const ITEM_MAX = 200;

export type PlacedItem = {
  id: string;
  kind: ItemKind;
  col: number;
  row: number;
  facing: ItemFacing;
};

export type Placement = Omit<PlacedItem, 'id'>;

/**
 * Validate a client `place-item` message: a known kind and facing and integer
 * tile coordinates inside the map. Returns only those fields, or null.
 */
export function normalizePlacement(msg: unknown): Placement | null {
  if (!msg || typeof msg !== 'object') return null;
  const m = msg as Record<string, unknown>;
  if (!(ITEM_KINDS as readonly unknown[]).includes(m.kind)) return null;
  if (!(ITEM_FACINGS as readonly unknown[]).includes(m.facing)) return null;
  const { col, row } = m;
  if (typeof col !== 'number' || !Number.isInteger(col) || col < 0 || col >= ITEM_COLS) return null;
  if (typeof row !== 'number' || !Number.isInteger(row) || row < 0 || row >= ITEM_ROWS) return null;
  return { kind: m.kind as ItemKind, col, row, facing: m.facing as ItemFacing };
}

/** An item id from a client `remove-item`: a short string, or null. */
export function normalizeItemId(raw: unknown): string | null {
  return typeof raw === 'string' && raw.length > 0 && raw.length <= 32 ? raw : null;
}

export type ItemStore = {
  list(): PlacedItem[];
  // Adds the item and returns it with its id, or null when the tile is already
  // taken or the space is full.
  add(p: Placement): PlacedItem | null;
  // Removes by id; true when something was removed.
  remove(id: string): boolean;
};

export function createItemStore(max: number = ITEM_MAX): ItemStore {
  const items = new Map<string, PlacedItem>();
  const taken = new Set<string>();
  const tileKey = (col: number, row: number) => `${col},${row}`;
  return {
    list: () => [...items.values()],
    add(p) {
      if (items.size >= max) return null;
      const key = tileKey(p.col, p.row);
      if (taken.has(key)) return null;
      const item: PlacedItem = { id: crypto.randomUUID().slice(0, 8), ...p };
      items.set(item.id, item);
      taken.add(key);
      return item;
    },
    remove(id) {
      const item = items.get(id);
      if (!item) return false;
      items.delete(id);
      taken.delete(tileKey(item.col, item.row));
      return true;
    },
  };
}
