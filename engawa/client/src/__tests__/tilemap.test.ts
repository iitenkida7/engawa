import { describe, expect, it } from 'bun:test';
import {
  canOccupy,
  findWalkableSpawn,
  isSolid,
  LOUNGE_TABLE_RECT,
  MAP_COLS,
  MAP_ROWS,
  OUTDOOR_MARGIN,
  officeMap,
  SOLID,
  TILE_SIZE,
  Tile,
  ZONES,
  zoneAt,
} from '@/world/tilemap';

// Pixel coordinate of the center of tile (col, row).
function center(col: number, row: number): { x: number; y: number } {
  return { x: col * TILE_SIZE + TILE_SIZE / 2, y: row * TILE_SIZE + TILE_SIZE / 2 };
}

// Find one solid and one floor tile from the generated map to test against.
function findTile(predicate: (t: number) => boolean): { col: number; row: number } {
  for (let r = 0; r < MAP_ROWS; r++) {
    for (let c = 0; c < MAP_COLS; c++) {
      if (predicate(officeMap[r][c])) return { col: c, row: r };
    }
  }
  throw new Error('no matching tile');
}

describe('isSolid', () => {
  it('returns true for a SOLID tile coordinate', () => {
    const { col, row } = findTile((t) => SOLID.has(t));
    const { x, y } = center(col, row);
    expect(isSolid(x, y)).toBe(true);
  });

  it('returns false for a FLOOR tile coordinate', () => {
    const { col, row } = findTile((t) => t === Tile.FLOOR);
    const { x, y } = center(col, row);
    expect(isSolid(x, y)).toBe(false);
  });

  it('treats out-of-bounds coordinates as solid', () => {
    expect(isSolid(-1, 10)).toBe(true);
    expect(isSolid(10, -1)).toBe(true);
    expect(isSolid(MAP_COLS * TILE_SIZE + 1, 10)).toBe(true);
    expect(isSolid(10, MAP_ROWS * TILE_SIZE + 1)).toBe(true);
  });
});

describe('canOccupy', () => {
  it('returns true when all four corners are on floor', () => {
    const { col, row } = findTile((t) => t === Tile.FLOOR);
    const { x, y } = center(col, row);
    expect(canOccupy(x, y, 5)).toBe(true);
  });

  it('returns false when a corner overlaps a wall', () => {
    // The building's top outer wall is at row OUTDOOR_MARGIN; a point just inside
    // it with a large radius has its top corner cross into the wall.
    const { x, y } = center(OUTDOOR_MARGIN + 2, OUTDOOR_MARGIN + 1);
    expect(canOccupy(x, y, TILE_SIZE)).toBe(false);
  });

  it('returns false when centered on a solid tile', () => {
    const { col, row } = findTile((t) => SOLID.has(t));
    const { x, y } = center(col, row);
    expect(canOccupy(x, y, 5)).toBe(false);
  });

  it('blocks the lounge coffee table even though its tiles are walkable (#225)', () => {
    const tableCx = LOUNGE_TABLE_RECT.x + LOUNGE_TABLE_RECT.w / 2;
    const tableCy = LOUNGE_TABLE_RECT.y + LOUNGE_TABLE_RECT.h / 2;
    expect(isSolid(tableCx, tableCy)).toBe(true);
    expect(canOccupy(tableCx, tableCy, 5)).toBe(false);
  });
});

describe('findWalkableSpawn', () => {
  it('returns the same point when already walkable', () => {
    const { col, row } = findTile((t) => t === Tile.FLOOR);
    const { x, y } = center(col, row);
    expect(findWalkableSpawn(x, y, 5)).toEqual({ x, y });
  });

  it('spirals out to a walkable tile center when the start is solid', () => {
    const { col, row } = findTile((t) => SOLID.has(t));
    const { x, y } = center(col, row);
    const spawn = findWalkableSpawn(x, y, 5);
    expect(canOccupy(spawn.x, spawn.y, 5)).toBe(true);
    // Snapped to a tile center.
    expect((spawn.x - TILE_SIZE / 2) % TILE_SIZE).toBe(0);
    expect((spawn.y - TILE_SIZE / 2) % TILE_SIZE).toBe(0);
  });
});

describe('ZONES / zoneAt (meeting-room zones)', () => {
  // One interior MEETING tile per walled-off room: the top strip (president's
  // office + all-hands + three meeting rooms) and the bottom strip (four 1-on-1
  // rooms + four negotiation booths).
  const roomSamples: { col: number; row: number }[] = [
    { col: 1, row: 1 }, // 社長室
    { col: 9, row: 1 }, // 大会議室 (corner tiles now hold plants)
    { col: 19, row: 1 }, // 会議室1
    { col: 24, row: 1 }, // 会議室2
    { col: 29, row: 1 }, // 会議室3
    { col: 1, row: 21 }, // 1on1ルーム1
    { col: 5, row: 21 }, // 1on1ルーム2
    { col: 9, row: 21 }, // 1on1ルーム3
    { col: 13, row: 21 }, // 1on1ルーム4
    { col: 17, row: 21 }, // 商談ブース1
    { col: 21, row: 21 }, // 商談ブース2
    { col: 25, row: 21 }, // 商談ブース3
    { col: 29, row: 21 }, // 商談ブース4
  ];

  it('derives one zone per walled-off MEETING room, plus the lounge', () => {
    // One zone per room sample + the open lounge (a conversation-restricted zone).
    expect(ZONES).toHaveLength(roomSamples.length + 1);
  });

  it('assigns a zone to every MEETING / LOUNGE tile and none to other tiles', () => {
    for (let r = 0; r < MAP_ROWS; r++) {
      for (let c = 0; c < MAP_COLS; c++) {
        const z = zoneAt(c * TILE_SIZE + TILE_SIZE / 2, r * TILE_SIZE + TILE_SIZE / 2);
        // The lounge is a zone too (an open call bubble), keyed off LOUNGE tiles.
        if (officeMap[r][c] === Tile.MEETING || officeMap[r][c] === Tile.LOUNGE) {
          expect(z).not.toBeNull();
        } else {
          expect(z).toBeNull();
        }
      }
    }
  });

  it('groups each room into a single distinct zone', () => {
    // roomSamples are building-local coords; shift into the map (#229).
    const ids = roomSamples.map((s) => {
      const cx = (s.col + OUTDOOR_MARGIN) * TILE_SIZE + TILE_SIZE / 2;
      const cy = (s.row + OUTDOOR_MARGIN) * TILE_SIZE + TILE_SIZE / 2;
      const z = zoneAt(cx, cy);
      expect(z).not.toBeNull();
      return z!.id;
    });
    // Every sampled room maps to a different zone (no room is merged with another).
    expect(new Set(ids).size).toBe(roomSamples.length);
  });

  it('returns null outside the map bounds', () => {
    expect(zoneAt(-10, -10)).toBeNull();
    expect(zoneAt(MAP_COLS * TILE_SIZE + 10, 0)).toBeNull();
  });
});
