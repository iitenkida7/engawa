import { describe, expect, it } from 'bun:test';
import {
  canOccupy,
  FLOOR_COLOR_COUNT,
  FLOOR_PATTERNS,
  findAdjacentSpawn,
  findWalkableSpawn,
  floorStyleAt,
  isDeskSeat,
  islandFloorStyle,
  isSolid,
  LOUNGE_TABLE_RECTS,
  LOUNGES,
  MAP_COLS,
  MAP_ROWS,
  OPEN_DESK_CHAIRS,
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
    const tableCx = LOUNGE_TABLE_RECTS[0].x + LOUNGE_TABLE_RECTS[0].w / 2;
    const tableCy = LOUNGE_TABLE_RECTS[0].y + LOUNGE_TABLE_RECTS[0].h / 2;
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

describe('findAdjacentSpawn', () => {
  // An open floor tile whose 8 neighbours are all occupiable (so direction tests
  // aren't foiled by a wall on one side).
  function openTileWithClearNeighbours(): { col: number; row: number } {
    for (let r = 1; r < MAP_ROWS - 1; r++) {
      for (let c = 1; c < MAP_COLS - 1; c++) {
        const { x, y } = center(c, r);
        if (!canOccupy(x, y, 5)) continue;
        let clear = true;
        for (let dr = -1; dr <= 1 && clear; dr++) {
          for (let dc = -1; dc <= 1; dc++) {
            const n = center(c + dc, r + dr);
            if (!canOccupy(n.x, n.y, 5)) {
              clear = false;
              break;
            }
          }
        }
        if (clear) return { col: c, row: r };
      }
    }
    throw new Error('no open tile with clear neighbours');
  }

  it('stops on a neighbour tile, never on the target tile itself', () => {
    const { col, row } = openTileWithClearNeighbours();
    const { x, y } = center(col, row);
    const spawn = findAdjacentSpawn(x, y, x + 500, y, 5);
    expect(spawn).not.toEqual({ x, y });
    expect(canOccupy(spawn.x, spawn.y, 5)).toBe(true);
    // Exactly one tile away (Chebyshev distance 1).
    const dCol = Math.round((spawn.x - x) / TILE_SIZE);
    const dRow = Math.round((spawn.y - y) / TILE_SIZE);
    expect(Math.max(Math.abs(dCol), Math.abs(dRow))).toBe(1);
  });

  it('picks the neighbour nearest the approacher', () => {
    const { col, row } = openTileWithClearNeighbours();
    const { x, y } = center(col, row);
    // Approaching from the east → stop on the east neighbour.
    expect(findAdjacentSpawn(x, y, x + 500, y, 5).x).toBeGreaterThan(x);
    // Approaching from the west → stop on the west neighbour.
    expect(findAdjacentSpawn(x, y, x - 500, y, 5).x).toBeLessThan(x);
  });
});

describe('isDeskSeat (private one-person desk seats)', () => {
  // The seat tile sits one row in front of the desk centre (south → above).
  const seats = OPEN_DESK_CHAIRS.map((ch) => ({
    col: ch.col,
    row: ch.row + (ch.facesSouth ? -1 : 1),
  }));

  it('is true on every desk seat tile and walkable there', () => {
    for (const s of seats) {
      const { x, y } = center(s.col, s.row);
      expect(isDeskSeat(x, y)).toBe(true);
      expect(canOccupy(x, y, 5)).toBe(true); // you can actually sit there
    }
  });

  it('is false on the desk tile itself and on open aisle floor', () => {
    const desk = center(OPEN_DESK_CHAIRS[0].col, OPEN_DESK_CHAIRS[0].row);
    expect(isDeskSeat(desk.x, desk.y)).toBe(false);
    // A spot far from any desk (map origin grass) is not a seat.
    expect(isDeskSeat(TILE_SIZE / 2, TILE_SIZE / 2)).toBe(false);
  });

  it('spaces seats so none sit in another seat’s adjacency ring (privacy)', () => {
    for (let i = 0; i < seats.length; i++) {
      for (let j = i + 1; j < seats.length; j++) {
        const cheby = Math.max(
          Math.abs(seats[i].col - seats[j].col),
          Math.abs(seats[i].row - seats[j].row),
        );
        expect(cheby).toBeGreaterThanOrEqual(2);
      }
    }
  });
});

describe('floor styles (randomised rugs)', () => {
  const M = OUTDOOR_MARGIN;
  const same = (a: { pattern: string; color: number }, b: { pattern: string; color: number }) =>
    a.pattern === b.pattern && a.color === b.color;

  it('gives every room a valid style, and open floor none', () => {
    const s = floorStyleAt(1 + M, 1 + M); // ceo office
    expect(s).not.toBeNull();
    expect(FLOOR_PATTERNS).toContain(s!.pattern);
    expect(s!.color).toBeGreaterThanOrEqual(0);
    expect(s!.color).toBeLessThan(FLOOR_COLOR_COUNT);
    // The central corridor (building row 13) is open floor — no rug.
    expect(floorStyleAt(16 + M, 13 + M)).toBeNull();
  });

  it('never repeats pattern+colour across adjacent top-strip rooms', () => {
    // Use non-desk interior tiles (desk tiles carry no zone).
    const ceo = floorStyleAt(1 + M, 1 + M)!;
    const allHands = floorStyleAt(8 + M, 2 + M)!;
    const meeting1 = floorStyleAt(19 + M, 1 + M)!;
    expect(same(ceo, allHands)).toBe(false);
    expect(same(allHands, meeting1)).toBe(false);
  });

  it('never repeats a colour within the top room strip', () => {
    const cols = [1, 8, 19, 24, 29].map((c) => floorStyleAt(c + M, 1 + M)?.color);
    expect(cols.every((c) => c !== undefined)).toBe(true);
    expect(new Set(cols).size).toBe(cols.length); // all distinct
  });

  it('gives the two cafés different styles', () => {
    const left = floorStyleAt(3, 22)!; // cafe-left (map cols 1-6, rows 20-24)
    const right = floorStyleAt(45, 22)!; // cafe-right (map cols 43-48)
    expect(left).not.toBeNull();
    expect(right).not.toBeNull();
    expect(same(left, right)).toBe(false);
  });

  it('shares a style within an island but differs between neighbours', () => {
    // Two pod rugs per island → rug 0 and rug 1 are the same island.
    expect(islandFloorStyle(0)).toEqual(islandFloorStyle(1));
    expect(same(islandFloorStyle(0), islandFloorStyle(2))).toBe(false); // next island along
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
    { col: 1, row: 23 }, // 1on1ルーム1
    { col: 5, row: 23 }, // 1on1ルーム2
    { col: 9, row: 23 }, // 1on1ルーム3
    { col: 13, row: 23 }, // 1on1ルーム4
    { col: 17, row: 23 }, // 商談ブース1
    { col: 21, row: 23 }, // 商談ブース2
    { col: 25, row: 23 }, // 商談ブース3
    { col: 29, row: 23 }, // 商談ブース4
  ];

  it('derives one zone per walled-off MEETING room, plus the cafés', () => {
    // One zone per room sample + the outdoor cafés (conversation-restricted zones).
    expect(ZONES).toHaveLength(roomSamples.length + LOUNGES.length);
  });

  it('zones cover every meeting/lounge tile and never bleed onto walls or grass', () => {
    for (let r = 0; r < MAP_ROWS; r++) {
      for (let c = 0; c < MAP_COLS; c++) {
        const z = zoneAt(c * TILE_SIZE + TILE_SIZE / 2, r * TILE_SIZE + TILE_SIZE / 2);
        const tile = officeMap[r][c];
        // MEETING / LOUNGE tiles are always inside a zone. (Room interiors also
        // zone their table/plant tiles so the floor rug shows under furniture.)
        if (tile === Tile.MEETING || tile === Tile.LOUNGE) expect(z).not.toBeNull();
        // Zones never extend onto the outer walls or the outdoor grass.
        if (tile === Tile.WALL || tile === Tile.GRASS || tile === Tile.TREE) expect(z).toBeNull();
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
