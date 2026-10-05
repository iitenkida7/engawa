// Grid-step movement helpers. Pure functions (no DOM, no game state) so the
// tile-stepping rules can be unit-tested in isolation, mirroring pathfind.ts.
// Used by keyboard movement to step one tile at a time (issue #206).

import type { Point } from '@/core/proximity';
import { defaultTileWalkable, type TileWalkable } from '@/world/pathfind';
import { TILE_SIZE } from '@/world/tilemap';

/** Center of the tile that contains (x, y). */
export function tileCenterAt(x: number, y: number): Point {
  const col = Math.floor(x / TILE_SIZE);
  const row = Math.floor(y / TILE_SIZE);
  return { x: col * TILE_SIZE + TILE_SIZE / 2, y: row * TILE_SIZE + TILE_SIZE / 2 };
}

/**
 * The center of the tile one step from (x, y) in the cardinal direction (dx, dy)
 * (each of dx/dy is -1, 0, or 1). Returns null when the destination tile is not
 * walkable (so the caller can turn to face it without moving). Only orthogonal
 * steps are supported — diagonal input is resolved to a single axis upstream.
 */
export function stepTarget(
  x: number,
  y: number,
  dx: number,
  dy: number,
  isWalkable: TileWalkable = defaultTileWalkable,
): Point | null {
  if (dx === 0 && dy === 0) return null;
  const col = Math.floor(x / TILE_SIZE) + dx;
  const row = Math.floor(y / TILE_SIZE) + dy;
  if (!isWalkable(col, row)) return null;
  return { x: col * TILE_SIZE + TILE_SIZE / 2, y: row * TILE_SIZE + TILE_SIZE / 2 };
}
