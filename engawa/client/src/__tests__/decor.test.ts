import { describe, expect, it } from 'bun:test';
import { floorKindAt, propFor } from '@/world/decor';
import { Tile } from '@/world/tilemap';

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
});
