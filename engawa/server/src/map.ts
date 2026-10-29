// The map this server runs (MAP / MAP_URL), loaded and validated once at boot
// and served to every client at GET /api/map. The format and its validator are
// shared with the client (../../maps/map-def.ts, mounted at /maps). The server
// itself only needs the map's pixel bounds (to clamp positions) and its spawn
// area; it never builds the tile grid.

import { assertMapDef, type MapDef, spawnArea, TILE_SIZE } from '../../maps/map-def';
import office from '../../maps/office.json';
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

// Bundled presets, selected by name with MAP (default: office).
const MAPS_DIR = new URL('../../maps/', import.meta.url);
export const DEFAULT_MAP = 'office';
// A preset name is a file name in MAPS_DIR, nothing that could walk out of it.
const PRESET_NAME = /^[a-z0-9][a-z0-9-]*$/;
// An external map is a few KB; refuse anything far past that, and don't hang
// the boot on a slow host.
export const MAX_MAP_BYTES = 1_000_000;
const MAP_FETCH_TIMEOUT_MS = 10_000;

/**
 * Load the configured map: MAP_URL (a JSON file over http(s)) or the bundled
 * preset named by MAP (default office). Both set is a configuration error, as
 * is anything that fails assertMapDef — the server refuses to start rather than
 * serve a map every browser would fail to build.
 */
export async function loadMap(
  env: { MAP?: string; MAP_URL?: string },
  fetchFn: typeof fetch = fetch,
): Promise<{ def: MapDef; source: string }> {
  const preset = env.MAP?.trim() || undefined;
  const url = env.MAP_URL?.trim() || undefined;
  if (preset && url) throw new Error('map: set either MAP or MAP_URL, not both');
  if (url) return { def: assertMapDef(await fetchMapJson(url, fetchFn)), source: url };

  const name = preset ?? DEFAULT_MAP;
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
    throw new Error(`map: MAP_URL is not a URL ('${raw}')`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:')
    throw new Error(`map: MAP_URL must be http(s) (got ${url.protocol})`);
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
