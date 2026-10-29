import { describe, expect, it } from 'bun:test';
import { assertMapDef, type MapDef } from '@/world/map-def';
import small from '@/world/maps/small.json';

// Bundled maps other than the default office (tilemap.ts builds the world from
// office.json, whose layout tilemap.test.ts pins). Until the app can load a
// preset, this is what keeps a bundled one loadable. assertMapDef freezes what
// it is given, so each map is checked on its own copy.
describe('bundled map presets', () => {
  it('small passes map validation', () => {
    expect(() => assertMapDef(structuredClone(small) as MapDef)).not.toThrow();
  });
});
