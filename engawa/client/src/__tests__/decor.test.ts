import { describe, expect, it } from 'bun:test';
import { floorKindAt, propFor, roomKindAt } from '@/world/decor';
import { canOccupy, MAP, TILE_SIZE, Tile } from '@/world/tilemap';

// The office building's origin in the map (world/maps/office.json).
const COL_OFF = 10;
const ROW_OFF = 8;
const [LOUNGE] = MAP.lounges;

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

// Building-local coords are shifted into the map by COL_OFF/ROW_OFF (#229).
describe('floorKindAt', () => {
  it('uses carpet inside a meeting-room zone', () => {
    // (col 3, row 2) sits inside the top-left office (a MEETING zone).
    expect(floorKindAt(3 + COL_OFF, 2 + ROW_OFF)).toBe('carpet');
  });

  it('uses wood in the open office (no zone)', () => {
    // (col 20, row 11) is open floor in the central office, outside every zone.
    expect(floorKindAt(20 + COL_OFF, 11 + ROW_OFF)).toBe('wood');
  });

  it('uses the lounge rug on a lounge tile', () => {
    const c = LOUNGE.c + Math.floor(LOUNGE.w / 2);
    const r = LOUNGE.r + Math.floor(LOUNGE.h / 2);
    expect(floorKindAt(c, r)).toBe('lounge');
  });
});

describe('roomKindAt', () => {
  it('classifies rooms for floor colour-coding, null in the open office', () => {
    expect(roomKindAt(3 + COL_OFF, 2 + ROW_OFF)).toBe('exec'); // president's office
    expect(roomKindAt(1 + COL_OFF, 23 + ROW_OFF)).toBe('oneonone'); // 1on1-1
    expect(roomKindAt(17 + COL_OFF, 23 + ROW_OFF)).toBe('booth'); // booth-1
    expect(roomKindAt(20 + COL_OFF, 11 + ROW_OFF)).toBeNull(); // open office
    const lc = LOUNGE.c + Math.floor(LOUNGE.w / 2);
    const lr = LOUNGE.r + Math.floor(LOUNGE.h / 2);
    expect(roomKindAt(lc, lr)).toBe('lounge');
  });
});

describe('lounge', () => {
  it('is walkable (an open social spot, not a solid prop)', () => {
    const cx = (LOUNGE.c + 0.5) * TILE_SIZE;
    const cy = (LOUNGE.r + 0.5) * TILE_SIZE;
    expect(canOccupy(cx, cy, 5)).toBe(true);
  });
});
