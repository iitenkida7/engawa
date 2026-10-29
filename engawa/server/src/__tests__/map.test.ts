import { describe, expect, test } from 'bun:test';
import office from '../../../maps/office.json';
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
    const { def, source } = await loadMap({});
    expect(source).toBe("preset 'office'");
    expect(mapWorld(def)).toEqual(OFFICE_WORLD);
  });

  test('loads a preset by name (blank counts as unset)', async () => {
    expect((await loadMap({ MAP: 'office' })).source).toBe("preset 'office'");
    expect((await loadMap({ MAP: ' ', MAP_URL: '' })).source).toBe("preset 'office'");
  });

  test('rejects an unknown preset, or a name that could leave the maps folder', async () => {
    await expect(loadMap({ MAP: 'nope' })).rejects.toThrow(/no preset 'nope'/);
    await expect(loadMap({ MAP: '../server/package' })).rejects.toThrow(/invalid preset name/);
  });

  test('refuses MAP and MAP_URL together (which one would win is a guess)', async () => {
    await expect(loadMap({ MAP: 'office', MAP_URL: 'https://x.test/m.json' })).rejects.toThrow(
      /either MAP or MAP_URL/,
    );
  });

  test('loads and validates a map from MAP_URL', async () => {
    const { def, source } = await loadMap({ MAP_URL: 'https://x.test/m.json' }, serve(OFFICE_JSON));
    expect(source).toBe('https://x.test/m.json');
    expect(mapWorld(def)).toEqual(OFFICE_WORLD);
  });

  test('fails the boot on a bad MAP_URL, naming why', async () => {
    const env = { MAP_URL: 'https://x.test/m.json' };
    await expect(loadMap({ MAP_URL: 'file:///etc/passwd' })).rejects.toThrow(/must be http\(s\)/);
    await expect(loadMap({ MAP_URL: 'not a url' })).rejects.toThrow(/not a URL/);
    await expect(loadMap(env, serve('', 404))).rejects.toThrow(/HTTP 404/);
    await expect(loadMap(env, serve('{oops'))).rejects.toThrow(/not valid JSON/);
    await expect(loadMap(env, serve(' '.repeat(MAX_MAP_BYTES + 1)))).rejects.toThrow(/over/);
    const broken = JSON.stringify({ ...office, cols: 0 });
    await expect(loadMap(env, serve(broken))).rejects.toThrow(/invalid map data/);
  });
});
