import { describe, expect, it } from 'bun:test';
import type { PlacedItem } from '@/core/types';
import {
  canPlaceAt,
  isSeatKind,
  PlacedItemStore,
  placedSeatAt,
  rotateFacing,
} from '@/world/placed-items';
import { isSolid, MAP_COLS, MAP_ROWS, officeMap, SOLID, TILE_SIZE, Tile } from '@/world/tilemap';

type Kind = PlacedItem['kind'];
const item = (id: string, col: number, row: number, kind: Kind = 'chair'): PlacedItem => ({
  id,
  kind,
  col,
  row,
  facing: 'down',
});

// A tile you can stand on: not solid terrain, not a table, not a map seat.
function freeTile() {
  for (let row = 2; row < MAP_ROWS - 2; row++) {
    for (let col = 2; col < MAP_COLS - 2; col++) {
      if (canPlaceAt(col, row, new PlacedItemStore())) return { col, row };
    }
  }
  throw new Error('no free tile');
}

describe('PlacedItemStore', () => {
  it('adds, finds by tile and removes, bumping the version each time', () => {
    const s = new PlacedItemStore();
    const v0 = s.version;
    s.add(item('a', 3, 4));
    expect(s.at(3, 4)?.id).toBe('a');
    expect(s.version).toBeGreaterThan(v0);
    const v1 = s.version;
    s.remove('a');
    expect(s.at(3, 4)).toBeUndefined();
    expect(s.version).toBeGreaterThan(v1);
  });

  it('set replaces everything', () => {
    const s = new PlacedItemStore();
    s.add(item('a', 1, 1));
    s.set([item('b', 2, 2)]);
    expect(s.all().map((i) => i.id)).toEqual(['b']);
  });

  it('removing something that is not there changes nothing', () => {
    const s = new PlacedItemStore();
    const v = s.version;
    s.remove('missing');
    expect(s.version).toBe(v);
  });
});

describe('canPlaceAt', () => {
  it('accepts free floor and refuses a tile that already holds an item', () => {
    const { col, row } = freeTile();
    const s = new PlacedItemStore();
    expect(canPlaceAt(col, row, s)).toBe(true);
    s.add(item('a', col, row));
    expect(canPlaceAt(col, row, s)).toBe(false);
  });

  it('refuses walls and solid terrain', () => {
    for (let row = 0; row < MAP_ROWS; row++) {
      for (let col = 0; col < MAP_COLS; col++) {
        if (SOLID.has(officeMap[row][col])) {
          expect(canPlaceAt(col, row, new PlacedItemStore())).toBe(false);
          return;
        }
      }
    }
    throw new Error('no solid tile');
  });

  it('refuses tiles outside the map', () => {
    const s = new PlacedItemStore();
    expect(canPlaceAt(-1, 0, s)).toBe(false);
    expect(canPlaceAt(0, -1, s)).toBe(false);
    expect(canPlaceAt(MAP_COLS, 0, s)).toBe(false);
    expect(canPlaceAt(0, MAP_ROWS, s)).toBe(false);
  });

  it('a placeable tile really is walkable', () => {
    const { col, row } = freeTile();
    expect(isSolid(col * TILE_SIZE + TILE_SIZE / 2, row * TILE_SIZE + TILE_SIZE / 2)).toBe(false);
    expect(officeMap[row][col]).not.toBe(Tile.WALL);
  });
});

describe('placedSeatAt', () => {
  const centre = (col: number, row: number): [number, number] => [
    col * TILE_SIZE + TILE_SIZE / 2,
    row * TILE_SIZE + TILE_SIZE / 2,
  ];

  it('a chair or bench seats whoever stands on its tile, facing the way it faces', () => {
    const s = new PlacedItemStore();
    s.add({ id: 'c', kind: 'chair', col: 5, row: 5, facing: 'left' });
    s.add({ id: 'b', kind: 'bench', col: 7, row: 5, facing: 'up' });
    expect(placedSeatAt(...centre(5, 5), s)).toEqual({
      facing: 'left',
      lift: 0,
    });
    expect(placedSeatAt(...centre(7, 5), s)?.facing).toBe('up');
  });

  it('a plant or an empty tile seats nobody', () => {
    const s = new PlacedItemStore();
    s.add(item('p', 5, 5, 'plant'));
    expect(placedSeatAt(...centre(5, 5), s)).toBeNull();
    expect(placedSeatAt(...centre(9, 9), s)).toBeNull();
  });
});

describe('helpers', () => {
  it('only chairs and benches are seats', () => {
    expect(isSeatKind('chair')).toBe(true);
    expect(isSeatKind('bench')).toBe(true);
    expect(isSeatKind('plant')).toBe(false);
  });

  it('rotateFacing makes a full turn in four steps', () => {
    let f = rotateFacing('down');
    const seen = new Set([f]);
    for (let i = 0; i < 3; i++) {
      f = rotateFacing(f);
      seen.add(f);
    }
    expect(f).toBe('down');
    expect(seen.size).toBe(4);
  });
});
