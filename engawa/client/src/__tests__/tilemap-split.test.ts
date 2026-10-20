import { describe, expect, test } from 'bun:test';
import {
  FLOOR_PATTERNS,
  type FloorStyle,
  floorStyleAt,
  islandFloorStyle,
  MAP_COLS,
  MAP_ROWS,
  officeMap,
  POD_RUGS,
  TREES,
  teamAreaFloorStyle,
} from '@/world/tilemap';

// Pins the generated layout (tree scatter + rug styles) to the snapshot taken
// before floor-styles.ts / trees.ts were split out of tilemap.ts, so moving the
// code can't silently change what the map looks like.
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
    expect(POD_RUGS.map((_, i) => islandFloorStyle(i))).toMatchSnapshot();
    expect(teamAreaFloorStyle()).toMatchSnapshot();
  });
});
