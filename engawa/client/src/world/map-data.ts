// The map the world is built from. The server picks it (MAP) and
// serves it at /api/map; core/boot.ts installs it here before any module that
// builds from it (world/tilemap.ts) is loaded. Tests install the bundled office
// map from their preload instead.

import { assertMapDef, type MapDef } from '@maps/map-def';

let installed: MapDef | null = null;
let taken = false;

/** Validate and install the map. Must run before world/tilemap.ts loads. */
export function installMap(def: unknown): void {
  // tilemap builds once at load; a map installed after that would never show.
  if (taken) throw new Error('map installed after the world was built from it');
  installed = assertMapDef(def);
}

/** The installed map, for world/tilemap.ts to build from (once, at load). */
export function takeMap(): MapDef {
  if (!installed) throw new Error('no map installed (load it before world/tilemap.ts)');
  taken = true;
  return installed;
}
