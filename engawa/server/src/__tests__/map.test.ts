import { describe, expect, test } from 'bun:test';
import { readdir } from 'node:fs/promises';
import office from '../../../maps/office_medium.json';
import { loadMap, MAX_MAP_BYTES, mapWorld, OFFICE_WORLD } from '../map';

// A fetch stand-in that answers every request with `body` (and `status`).
function serve(body: string, status = 200): typeof fetch {
  return (async () => new Response(body, { status })) as unknown as typeof fetch;
}
const OFFICE_JSON = JSON.stringify(office);

describe('mapWorld', () => {
  // The bounds and spawn aisle the server hardcoded before maps became data.
  test('gives the office its 52×43-tile bounds and center-aisle spawn', () => {
    expect(OFFICE_WORLD).toEqual({
      width: 2600,
      height: 2150,
      spawn: { x: 1200, y: 800, w: 400, h: 600 },
    });
  });
});

describe('loadMap', () => {
  test('defaults to the bundled office preset', async () => {
    const { def, source } = await loadMap(undefined);
    expect(source).toBe("preset 'office_medium'");
    expect(mapWorld(def)).toEqual(OFFICE_WORLD);
  });

  test('loads a preset by name (blank counts as unset)', async () => {
    expect((await loadMap('office_medium')).source).toBe("preset 'office_medium'");
    expect((await loadMap(' ')).source).toBe("preset 'office_medium'");
  });

  test('rejects an unknown preset, or a name that could leave the maps folder', async () => {
    await expect(loadMap('nope')).rejects.toThrow(/no preset 'nope'/);
    await expect(loadMap('../server/package')).rejects.toThrow(/invalid preset name/);
    await expect(loadMap('/data/map.json')).rejects.toThrow(/invalid preset name/);
  });

  test('loads and validates a map from a URL', async () => {
    const { def, source } = await loadMap('https://x.test/m.json', serve(OFFICE_JSON));
    expect(source).toBe('https://x.test/m.json');
    expect(mapWorld(def)).toEqual(OFFICE_WORLD);
  });

  test('fails the boot on a bad map URL, naming why', async () => {
    const env = 'https://x.test/m.json';
    await expect(loadMap('file:///etc/passwd')).rejects.toThrow(/must be http\(s\)/);
    await expect(loadMap('https://')).rejects.toThrow(/not a URL/);
    await expect(loadMap(env, serve('', 404))).rejects.toThrow(/HTTP 404/);
    await expect(loadMap(env, serve('{oops'))).rejects.toThrow(/not valid JSON/);
    await expect(loadMap(env, serve(' '.repeat(MAX_MAP_BYTES + 1)))).rejects.toThrow(/over/);
    const broken = JSON.stringify({ ...office, cols: 0 });
    await expect(loadMap(env, serve(broken))).rejects.toThrow(/invalid map data/);
  });
});

describe('bundled presets', () => {
  // Every map shipped in maps/ has to load: a broken one would only surface
  // when someone points MAP at it and the server refuses to boot.
  test('every bundled map loads and validates', async () => {
    const names = (await readdir(new URL('../../../maps/', import.meta.url)))
      // maps/ also holds its own biome.json; everything else there is a map.
      .filter((f) => f.endsWith('.json') && f !== 'biome.json')
      .map((f) => f.slice(0, -'.json'.length));
    expect(names).toEqual(expect.arrayContaining(['office_medium', 'office_small']));
    for (const name of names) expect((await loadMap(name)).source).toBe(`preset '${name}'`);
  });
});
