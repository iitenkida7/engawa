import { describe, expect, it } from 'bun:test';
import { floorKindAt, propFor, roomKindAt } from '@/world/decor';
import { canOccupy, LOUNGE, TILE_SIZE, Tile } from '@/world/tilemap';

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

describe('floorKindAt', () => {
  it('uses carpet inside a meeting-room zone', () => {
    // (col 3, row 2) sits inside the top-left office (a MEETING zone).
    expect(floorKindAt(3, 2)).toBe('carpet');
  });

  it('uses wood in the open office (no zone)', () => {
    // (col 20, row 11) is open floor in the central office, outside every zone.
    expect(floorKindAt(20, 11)).toBe('wood');
  });

  it('uses the lounge rug on a lounge tile', () => {
    const c = LOUNGE.c + Math.floor(LOUNGE.w / 2);
    const r = LOUNGE.r + Math.floor(LOUNGE.h / 2);
    expect(floorKindAt(c, r)).toBe('lounge');
  });
});

describe('roomKindAt', () => {
  it('classifies rooms for floor colour-coding, null in the open office', () => {
    expect(roomKindAt(3, 2)).toBe('exec'); // president's office
    expect(roomKindAt(1, 20)).toBe('oneonone'); // 1on1-1
    expect(roomKindAt(17, 20)).toBe('booth'); // booth-1
    expect(roomKindAt(20, 11)).toBeNull(); // open office
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
