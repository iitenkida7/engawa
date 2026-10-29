// Floor rug patterns the renderer can draw. Named here so a room/café can request
// a specific one; the renderer (canvas.ts) maps each to a drawing.
export type FloorPattern =
  | 'none'
  | 'stripe'
  | 'vstripe'
  | 'checker'
  | 'houndstooth'
  | 'brick'
  | 'crosshatch'
  | 'herringbone'
  | 'chevron';

// ===== Rug styles (#263 follow-up) =====
// Every room, café and desk pod gets a (pattern, colour) rug, picked per area in
// the map data (world/map-def.ts FloorDef). The renderer (map-art.ts) maps the
// colour index to a concrete base/accent theme.
export const FLOOR_PATTERNS: FloorPattern[] = [
  'stripe',
  'vstripe',
  'checker',
  'houndstooth',
  'brick',
  'crosshatch',
  'herringbone',
  'chevron',
];
export const FLOOR_COLOR_COUNT = 8;
// Extra colour index past the regular 0..FLOOR_COLOR_COUNT-1 themes: the cafés'
// dedicated red theme.
export const CAFE_COLOR = FLOOR_COLOR_COUNT;
export type FloorStyle = { pattern: FloorPattern; color: number };
