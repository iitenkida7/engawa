import { describe, expect, test } from 'bun:test';
import { floorKindAt, roomKindAt } from '@/world/decor';
import {
  ARMCHAIR_SPOTS,
  callZoneAt,
  deskFacesSouth,
  FLOOR_PATTERNS,
  type FloorStyle,
  floorStyleAt,
  isDeskSeat,
  isMeetingRoom,
  LOUNGE_RECTS,
  LOUNGE_TABLE_RECTS,
  MAP_COLS,
  MAP_ROWS,
  MEETING_ROOM_RECTS,
  OPEN_DESK_CHAIRS,
  officeMap,
  POD_RUGS,
  POND_RECTS,
  podRugAt,
  podRugStyle,
  ROOM_FURNITURE,
  seatAt,
  TEAM_AREAS,
  TILE_SIZE,
  TREES,
  ZONES,
  zoneAt,
} from '@/world/tilemap';

// Pins the generated layout (trees + rug styles) to the snapshot taken before
// floor-styles.ts / trees.ts were split out of tilemap.ts and the layout moved
// into map data, so moving the code can't silently change what the map looks like.
describe('generated layout is unchanged by the tilemap split', () => {
  test('tree placement and the stamped map', () => {
    expect(TREES).toMatchSnapshot();
    expect(officeMap.map((row) => row.join(''))).toMatchSnapshot();
  });

  test('floor styles for every tile, island and the team area', () => {
    const code = (s: FloorStyle | null) =>
      s ? `${FLOOR_PATTERNS.indexOf(s.pattern)}${s.color}` : '--';
    const grid: string[] = [];
    for (let r = 0; r < MAP_ROWS; r++) {
      let line = '';
      for (let c = 0; c < MAP_COLS; c++) line += code(floorStyleAt(c, r));
      grid.push(line);
    }
    expect(grid).toMatchSnapshot();
    expect(POD_RUGS.map((_, i) => podRugStyle(i))).toMatchSnapshot();
    expect(TEAM_AREAS[0].style).toMatchSnapshot();
  });
});

// Pins every derived geometry/lookup the rest of the app reads from tilemap, so
// moving the office layout into map data (MapDef) can't change the world.
describe('derived world is unchanged by the map-data move', () => {
  test('exported rects and lists', () => {
    expect({
      MAP_COLS,
      MAP_ROWS,
      ZONES,
      ROOM_FURNITURE,
      MEETING_ROOM_RECTS,
      POD_RUGS,
      TEAM_AREAS,
      OPEN_DESK_CHAIRS,
      LOUNGE_RECTS,
      LOUNGE_TABLE_RECTS,
      ARMCHAIR_SPOTS,
      POND_RECTS,
      meetingRooms: ZONES.filter((z) => isMeetingRoom(z.id)).map((z) => z.id),
    }).toMatchSnapshot();
  });

  test('per-tile lookups', () => {
    const rows: string[] = [];
    for (let r = 0; r < MAP_ROWS; r++) {
      const cells: string[] = [];
      for (let c = 0; c < MAP_COLS; c++) {
        const x = c * TILE_SIZE + TILE_SIZE / 2;
        const y = r * TILE_SIZE + TILE_SIZE / 2;
        const seat = seatAt(x, y);
        const rug = podRugAt(x, y);
        cells.push(
          [
            zoneAt(x, y)?.id ?? '',
            callZoneAt(x, y) ?? '',
            isDeskSeat(x, y) ? 'S' : '',
            deskFacesSouth(c, r) ? 'v' : '',
            seat ? `${seat.facing}${seat.lift}` : '',
            rug ? `${rug.x},${rug.y}` : '',
            roomKindAt(c, r) ?? '',
            floorKindAt(c, r),
          ].join('/'),
        );
      }
      rows.push(cells.join(' '));
    }
    expect(rows).toMatchSnapshot();
    // Armchair spots (sub-tile) — sample each spot's centre.
    expect(ARMCHAIR_SPOTS.map((a) => seatAt(a.x, a.y))).toMatchSnapshot();
  });
});
