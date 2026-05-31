// A* pathfinding over the office tile grid. Pure functions (no DOM, no game
// state) so the routing rules can be unit-tested in isolation, mirroring the
// style of proximity.ts. Used by click-to-move to walk around walls/desks.

import type { Point } from '@/core/proximity';
import { TILE_SIZE, MAP_COLS, MAP_ROWS, canOccupy } from '@/world/tilemap';
import { COLLISION_RADIUS } from '@/core/types';

export type TileWalkable = (col: number, row: number) => boolean;

/** A tile is walkable when a player centered on it (radius included) fits. */
export function defaultTileWalkable(col: number, row: number): boolean {
  if (col < 0 || col >= MAP_COLS || row < 0 || row >= MAP_ROWS) return false;
  const cx = col * TILE_SIZE + TILE_SIZE / 2;
  const cy = row * TILE_SIZE + TILE_SIZE / 2;
  return canOccupy(cx, cy, COLLISION_RADIUS);
}

function tileCenter(col: number, row: number): Point {
  return { x: col * TILE_SIZE + TILE_SIZE / 2, y: row * TILE_SIZE + TILE_SIZE / 2 };
}

// 8-directional steps with their movement cost (orthogonal 1, diagonal √2).
const NEIGHBORS: Array<[number, number, number]> = [
  [1, 0, 1],
  [-1, 0, 1],
  [0, 1, 1],
  [0, -1, 1],
  [1, 1, Math.SQRT2],
  [1, -1, Math.SQRT2],
  [-1, 1, Math.SQRT2],
  [-1, -1, Math.SQRT2],
];

/**
 * A* over the tile grid. Returns the waypoint tile-centers from just after the
 * `start` tile up to and including the `goal` tile. Returns an empty array when
 * start and goal are the same tile, or when no path exists.
 *
 * Movement is 8-directional with corner-cutting disallowed: a diagonal step is
 * only allowed when both shared orthogonal tiles are also walkable, so the
 * player never clips a wall/desk corner.
 */
export function findPath(
  start: Point,
  goal: Point,
  isWalkable: TileWalkable = defaultTileWalkable,
): Point[] {
  const sCol = Math.floor(start.x / TILE_SIZE);
  const sRow = Math.floor(start.y / TILE_SIZE);
  const gCol = Math.floor(goal.x / TILE_SIZE);
  const gRow = Math.floor(goal.y / TILE_SIZE);

  if (!isWalkable(sCol, sRow) || !isWalkable(gCol, gRow)) return [];
  if (sCol === gCol && sRow === gRow) return [];

  const key = (c: number, r: number) => r * MAP_COLS + c;
  const startKey = key(sCol, sRow);
  const goalKey = key(gCol, gRow);

  const gScore = new Map<number, number>([[startKey, 0]]);
  const cameFrom = new Map<number, number>();
  const open = new Set<number>([startKey]);

  // Octile distance heuristic — admissible for 8-directional movement.
  const heuristic = (c: number, r: number) => {
    const dc = Math.abs(c - gCol);
    const dr = Math.abs(r - gRow);
    return dc + dr + (Math.SQRT2 - 2) * Math.min(dc, dr);
  };

  while (open.size > 0) {
    // The grid is tiny (40×30), so a linear scan for the lowest f-score is
    // cheap and avoids a priority-queue dependency.
    let current = -1;
    let bestF = Infinity;
    for (const k of open) {
      const f = (gScore.get(k) ?? Infinity) + heuristic(k % MAP_COLS, Math.floor(k / MAP_COLS));
      if (f < bestF) {
        bestF = f;
        current = k;
      }
    }

    if (current === goalKey) {
      const path: Point[] = [];
      let k = goalKey;
      while (k !== startKey) {
        path.push(tileCenter(k % MAP_COLS, Math.floor(k / MAP_COLS)));
        const prev = cameFrom.get(k);
        if (prev === undefined) break;
        k = prev;
      }
      path.reverse();
      return path;
    }

    open.delete(current);
    const cc = current % MAP_COLS;
    const cr = Math.floor(current / MAP_COLS);

    for (const [dc, dr, cost] of NEIGHBORS) {
      const nc = cc + dc;
      const nr = cr + dr;
      if (nc < 0 || nc >= MAP_COLS || nr < 0 || nr >= MAP_ROWS) continue;
      if (!isWalkable(nc, nr)) continue;
      // No corner cutting: both orthogonal neighbours shared with the diagonal
      // must be walkable.
      if (dc !== 0 && dr !== 0 && (!isWalkable(cc + dc, cr) || !isWalkable(cc, cr + dr))) continue;

      const nk = key(nc, nr);
      const tentative = (gScore.get(current) ?? Infinity) + cost;
      if (tentative < (gScore.get(nk) ?? Infinity)) {
        cameFrom.set(nk, current);
        gScore.set(nk, tentative);
        open.add(nk);
      }
    }
  }

  return [];
}
