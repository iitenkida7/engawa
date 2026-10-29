import { describe, expect, it } from 'bun:test';
import { assertMapDef, type MapDef } from '@/world/map-def';

// A map is JSON: the MapDef types say nothing about what actually loads, so the
// validator is the only thing between a typo and an undefined deep inside the
// renderer. These are the mistakes a hand-authored map actually makes.
const BASE: MapDef = {
  version: 1,
  cols: 20,
  rows: 20,
  buildings: [{ c: 2, r: 2, w: 10, h: 10, doors: [[2, 6]] }],
  rooms: [
    {
      id: 'r1',
      kind: 'meeting',
      name: { ja: '会議室', en: 'Meeting room' },
      c: 4,
      r: 4,
      w: 3,
      h: 3,
      doors: [[5, 3]],
      table: { c: 5, r: 5, w: 1, h: 1 },
      floor: { pattern: 'brick', color: 1 },
    },
  ],
  desks: [{ c: 8, r: 8, facing: 'south', rug: { pattern: 'chevron', color: 2 } }],
  teamAreas: [],
  lounges: [],
  plants: [[3, 9]],
  ponds: [{ c: 15, r: 2, w: 2, h: 2 }],
  trees: [{ c: 16, r: 10, size: 2, variant: 0 }],
};

// assertMapDef freezes what it is given, so every case gets its own copy.
const map = (over: Partial<MapDef> = {}): MapDef => ({ ...structuredClone(BASE), ...over });

describe('assertMapDef', () => {
  it('accepts a well-formed map', () => {
    expect(() => assertMapDef(map())).not.toThrow();
  });

  it('rejects a map written for another MapDef version', () => {
    expect(() => assertMapDef(map({ version: 2 as 1 }))).toThrow(/version/);
  });

  it('rejects a floor colour with no theme (it used to blank the whole canvas)', () => {
    const d = map();
    d.rooms[0].floor = { pattern: 'brick', color: 99 };
    expect(() => assertMapDef(d)).toThrow(/colour 99/);
    const e = map();
    e.desks[0].rug = { pattern: 'brick', color: -1 };
    expect(() => assertMapDef(e)).toThrow(/colour -1/);
  });

  it('rejects a pattern the renderer cannot draw', () => {
    const d = map();
    d.rooms[0].floor = { pattern: 'tartan' as 'brick', color: 1 };
    expect(() => assertMapDef(d)).toThrow(/pattern 'tartan'/);
  });

  it('rejects a malformed door (which used to leave a room with no way in)', () => {
    const d = map();
    d.rooms[0].doors = [[5] as unknown as [number, number]];
    expect(() => assertMapDef(d)).toThrow(/\[col, row\]/);
  });

  it('rejects geometry that runs off the map, wall ring included', () => {
    const d = map();
    d.rooms[0].c = 0; // its wall ring would need column -1
    expect(() => assertMapDef(d)).toThrow(/outside the 20x20 map/);
    const e = map();
    e.trees[0] = { c: 19, r: 10, size: 2, variant: 0 }; // 2×2 from the last column
    expect(() => assertMapDef(e)).toThrow(/outside the 20x20 map/);
    const f = map();
    f.plants[0] = [3, 20];
    expect(() => assertMapDef(f)).toThrow(/outside the map/);
  });

  it('freezes the map, so the styles it hands out cannot be rewritten', () => {
    const def = assertMapDef(map());
    // Every area without a rug shares one style object, and a room's rug IS this
    // JSON object — a stray write would restyle the map for the whole session.
    expect(() => {
      const floor = def.rooms[0].floor;
      if (floor) floor.color = 7;
    }).toThrow();
    expect(def.rooms[0].floor?.color).toBe(1);
  });
});
