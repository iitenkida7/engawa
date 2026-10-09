import { describe, expect, it } from 'bun:test';
import { floorKindAt, propFor, roomKindAt } from '@/world/decor';
import { canOccupy, LOUNGES, OUTDOOR_MARGIN as M, TILE_SIZE, Tile } from '@/world/tilemap';

describe('propFor', () => {
  it('maps desk and plant tiles to their props, everything else to null', () => {
    expect(propFor(Tile.DESK)).toBe('desk');
    expect(propFor(Tile.PLANT)).toBe('plant');
    expect(propFor(Tile.FLOOR)).toBeNull();
    expect(propFor(Tile.WALL)).toBeNull();
    expect(propFor(Tile.MEETING)).toBeNull();
    expect(propFor(Tile.LOUNGE)).toBeNull();
  });
});

// Building-local coords are shifted into the map by OUTDOOR_MARGIN (#229).
describe('floorKindAt', () => {
  it('uses carpet inside a meeting-room zone', () => {
    // (col 3, row 2) sits inside the top-left office (a MEETING zone).
    expect(floorKindAt(3 + M, 2 + M)).toBe('carpet');
  });

  it('uses wood in the open office (no zone)', () => {
    // (col 20, row 11) is open floor in the central office, outside every zone.
    expect(floorKindAt(20 + M, 11 + M)).toBe('wood');
  });

  it('uses the lounge rug on a lounge tile', () => {
    const c = LOUNGES[0].c + M + Math.floor(LOUNGES[0].w / 2);
    const r = LOUNGES[0].r + M + Math.floor(LOUNGES[0].h / 2);
    expect(floorKindAt(c, r)).toBe('lounge');
  });
});

describe('roomKindAt', () => {
  it('classifies rooms for floor colour-coding, null in the open office', () => {
    expect(roomKindAt(3 + M, 2 + M)).toBe('exec'); // president's office
    expect(roomKindAt(1 + M, 23 + M)).toBe('oneonone'); // 1on1-1
    expect(roomKindAt(17 + M, 23 + M)).toBe('booth'); // booth-1
    expect(roomKindAt(20 + M, 11 + M)).toBeNull(); // open office
    const lc = LOUNGES[0].c + M + Math.floor(LOUNGES[0].w / 2);
    const lr = LOUNGES[0].r + M + Math.floor(LOUNGES[0].h / 2);
    expect(roomKindAt(lc, lr)).toBe('lounge');
  });
});

describe('lounge', () => {
  it('is walkable (an open social spot, not a solid prop)', () => {
    const cx = (LOUNGES[0].c + M + 0.5) * TILE_SIZE;
    const cy = (LOUNGES[0].r + M + 0.5) * TILE_SIZE;
    expect(canOccupy(cx, cy, 5)).toBe(true);
  });
});
