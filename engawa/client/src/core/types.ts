// The wire-protocol types live in ../../shared/protocol.ts (the @shared
// alias) — the single source of truth shared with the server. They are
// re-exported here so application code keeps importing from '@/core/types'.
// Client-only constants and helpers stay below.
export type {
  ClientMessage,
  GroupMethod,
  Outfit,
  Player,
  PlayerStatus,
  ServerMessage,
  SfuTrack,
  SignalData,
  StreamKind,
} from '@shared/protocol';

export const MAP_WIDTH = 2000;
export const MAP_HEIGHT = 1500;
export const PLAYER_RADIUS = 20;
// Collision uses a smaller radius than the drawn avatar so squeezing between
// solid tiles is forgiving: a one-tile (50px) gap leaves an 18px window for the
// center instead of 10px. The avatar still renders at PLAYER_RADIUS.
export const COLLISION_RADIUS = 16;
// Pixels per second. Frame-rate independent; the per-frame delta is computed
// with the actual dt of each frame.
export const PLAYER_SPEED = 210;
// Double-click (click-to-move) travels at this multiple of PLAYER_SPEED.
export const CLICK_MOVE_MULTIPLIER = 3;
// Distance (px) within which a click-to-move waypoint counts as reached.
export const CLICK_MOVE_ARRIVE_THRESHOLD = 4;
// Open-floor proximity range, in px, used only to draw the avatar's ring as a
// visual hint of who is roughly in range. Actual call membership (and the
// connect/disconnect hysteresis) is decided server-side by computeProximityGroups
// and pushed via group-update; the client no longer connects/disconnects by
// pairwise distance. Mirrors the server's PROXIMITY_CONNECT_RADIUS.
export const CONNECT_RADIUS = 120;
export const POSITION_SEND_INTERVAL_MS = 50;
// How aggressively remote players are pulled toward their predicted position
// each frame. Higher = snappier but more jitter on noisy networks.
// alpha_per_60fps_frame ≈ 1 - exp(-decay/60). 40 → ~0.49.
export const INTERP_DECAY = 40;
// Cap how far into the future we extrapolate when the network goes silent.
export const EXTRAP_MAX_MS = 200;
// Map zoom is zoom-OUT only: ZOOM_MAX (1.0) is the default 1:1 view, smaller
// values pull the camera back to survey more of the office. The toolbar +/-
// buttons step multiplicatively by ZOOM_STEP, clamped to [ZOOM_MIN, ZOOM_MAX].
// self stays centered; only the scale changes.
export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 1.0;
export const ZOOM_STEP = 1.2;

// Max length of a status one-liner (issue #85). The input enforces it client
// side; the server also clamps to this on relay so a crafted message can't
// flood peers with a huge note.
export const STATUS_NOTE_MAX_LEN = 40;
// Return-time presets offered in the status menu, in minutes. `null` = no time.
export const STATUS_UNTIL_PRESETS_MIN = [15, 30, 60] as const;

// Format an absolute return time (epoch ms) as local HH:MM, or '' when there's
// no time or it has already passed. Pure so the label logic is unit-testable;
// each client formats with its own clock (minor skew is fine for a "戻り時刻").
export function formatUntil(until: number | null | undefined, now = Date.now()): string {
  if (until == null || until <= now) return '';
  const d = new Date(until);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

// Emoji reactions (issue #23). The toolbar offers these as buttons and number
// keys 1–6 map to them in order; the server validates against the same list
// (server/src/logic.ts REACTION_EMOJIS) so keep the two in sync.
export const REACTION_EMOJIS = ['👋', '👍', '❤️', '😂', '🎉', '🙏'] as const;
// How long a reaction bubble lives (ms) — it floats up and fades over this span.
export const REACTION_LIFETIME_MS = 1500;
// Min gap (ms) between reactions we send, to debounce mashing a button / key.
export const REACTION_DEBOUNCE_MS = 300;
