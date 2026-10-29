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

// Rug colour themes (#263 follow-up): a pale base fill + a matching accent for
// the pattern marks, indexed by FloorStyle.color (the regular themes, then
// CAFE_COLOR). Kept here rather than with the renderer so the map validator
// bounds `color` by this very list and the two cannot drift.
export const FLOOR_THEMES: { base: string; accent: string }[] = [
  // Muted, greyed mid-tones (calm, not colourful) — matched to the slate feel.
  { base: '#b4c2a8', accent: 'rgba(84,106,78,0.32)' }, // green — greyed sage
  { base: '#b2c0d4', accent: 'rgba(74,100,138,0.32)' }, // blue — greyed
  { base: '#c3bcce', accent: 'rgba(104,92,134,0.3)' }, // lavender — greyed mauve
  { base: '#d2bcc3', accent: 'rgba(158,108,126,0.3)' }, // pink — greyed rose
  { base: '#f4efdd', accent: 'rgba(176,152,88,0.22)' }, // amber — near-white, faint yellow
  { base: '#dce2e0', accent: 'rgba(108,128,124,0.24)' }, // teal — pale greyish
  { base: '#d1b8ab', accent: 'rgba(158,104,78,0.3)' }, // terracotta — greyed clay
  { base: '#bcc4d6', accent: 'rgba(84,100,132,0.32)' }, // slate
  // Index 8 (CAFE_COLOR): reserved greige theme for the lounges.
  { base: '#dcd4c6', accent: 'rgba(122,110,90,0.26)' }, // lounge — greige / taupe
];
