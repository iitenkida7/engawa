import { describe, expect, it } from 'bun:test';
import office from '@maps/office_medium.json';
import { installMap } from '@/world/map-data';
import { MAP } from '@/world/tilemap';

describe('installMap', () => {
  // The test preload installed the office map and tilemap has now built from it.
  it('refuses a map once the world was built (it would never show)', () => {
    expect(MAP.cols).toBe(office.cols);
    expect(() => installMap(structuredClone(office))).toThrow(/after the world was built/);
  });
});
