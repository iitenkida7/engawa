// The map this server runs (MAP: a bundled template name or a URL), loaded and validated once at boot
// and served to every client at GET /api/map. The format and its validator are
// shared with the client (../../maps/map-def.ts, mounted at /maps). The server
// itself only needs the map's pixel bounds (to clamp positions) and its spawn
// area; it never builds the tile grid.

import { assertMapDef, type MapDef, spawnArea, TILE_SIZE } from '../../maps/map-def';
import office from '../../maps/office_medium.json';
import type { PixelRect } from './logic';

/** What the server takes from the map: its size and where newcomers appear, in px. */
export type MapWorld = { width: number; height: number; spawn: PixelRect };

export function mapWorld(def: MapDef): MapWorld {
  const s = spawnArea(def);
  return {
    width: def.cols * TILE_SIZE,
    height: def.rows * TILE_SIZE,
    spawn: { x: s.c * TILE_SIZE, y: s.r * TILE_SIZE, w: s.w * TILE_SIZE, h: s.h * TILE_SIZE },
  };
}

/** The bundled office map's world: the default for unit tests. */
export const OFFICE_WORLD: MapWorld = mapWorld(assertMapDef(structuredClone(office)));

// Bundled presets, selected by name with MAP (default: office_medium). Names are
// prefixed by what they are, so variants of a kind sort together.
const MAPS_DIR = new URL('../../maps/', import.meta.url);
export const DEFAULT_MAP = 'office_medium';
// A preset name is a file name in MAPS_DIR, nothing that could walk out of it.
const PRESET_NAME = /^[a-z0-9][a-z0-9_-]*$/;
// An external map is a few KB; refuse anything far past that, and don't hang
// the boot on a slow host.
export const MAX_MAP_BYTES = 1_000_000;
const MAP_FETCH_TIMEOUT_MS = 10_000;

/**
 * Load the configured map. MAP is either a JSON file over http(s) (a value with
 * a scheme) or the name of a bundled preset; unset means office. A map that
 * can't be loaded or fails assertMapDef is a configuration error — the server
 * refuses to start rather than serve a map every browser would fail to build.
 */
export async function loadMap(
  map: string | undefined,
  fetchFn: typeof fetch = fetch,
): Promise<{ def: MapDef; source: string }> {
  const value = map?.trim() || DEFAULT_MAP;
  if (value.includes('://'))
    return { def: assertMapDef(await fetchMapJson(value, fetchFn)), source: value };

  const name = value;
  if (!PRESET_NAME.test(name)) throw new Error(`map: invalid preset name '${name}'`);
  const file = Bun.file(new URL(`${name}.json`, MAPS_DIR));
  if (!(await file.exists())) throw new Error(`map: no preset '${name}' (maps/${name}.json)`);
  return { def: assertMapDef(await file.json()), source: `preset '${name}'` };
}

async function fetchMapJson(raw: string, fetchFn: typeof fetch): Promise<unknown> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`map: MAP is not a URL ('${raw}')`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:')
    throw new Error(`map: a MAP URL must be http(s) (got ${url.protocol})`);
  const res = await fetchFn(url, { signal: AbortSignal.timeout(MAP_FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`map: GET ${url} failed (HTTP ${res.status})`);
  const text = await res.text();
  if (text.length > MAX_MAP_BYTES) throw new Error(`map: ${url} is over ${MAX_MAP_BYTES} bytes`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`map: ${url} is not valid JSON`);
  }
}
