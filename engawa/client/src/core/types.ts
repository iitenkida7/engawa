import type { Outfit } from '@/world/outfit';

export type { Outfit };

export type Player = {
  userId: string;
  name: string;
  x: number;
  y: number;
  // Modular avatar configuration (#141). Optional so a peer/server that omits it
  // (or an older client) still parses; the renderer falls back to defaults.
  outfit?: Outfit;
};

export type SignalData = unknown;

export type StreamKind = 'mic' | 'cam' | 'screen';

export type GroupMethod = 'mesh' | 'sfu';

// One published SFU track (kind → Cloudflare trackName) in the per-user track
// directory the server relays so peers can pull each other.
export type SfuTrack = { kind: StreamKind; trackName: string };

export type PlayerStatus = 'online' | 'busy' | 'away' | 'meeting' | 'break';

export type ClientMessage =
  | { type: 'join'; name: string; workspace: string; password?: string; outfit?: Outfit }
  // Avatar appearance changed in the editor; relayed to the workspace so peers
  // re-render this avatar. Stateless: the server forwards it, keeping nothing.
  | { type: 'outfit-update'; outfit: Outfit }
  | { type: 'move'; x: number; y: number; vx: number; vy: number; zoneId?: string | null }
  // `note` is an optional free-text one-liner ("ランチ"); `until` is an optional
  // return time as absolute epoch ms (null = none). Both ride the existing
  // status sync (#85); the server relays them without storing.
  | {
      type: 'status';
      status: PlayerStatus;
      isMuted: boolean;
      isVideoOn: boolean;
      note?: string;
      until?: number | null;
    }
  | { type: 'signal'; to: string; data: SignalData }
  | { type: 'stream-meta'; to: string; streamId: string; kind: StreamKind | 'removed' }
  // A chat line, relayed to the sender's current proximity group (the people
  // they're in a call with), so text stays spatial. The server keeps no history.
  | { type: 'chat'; text: string }
  // A knock (call request) and its accept/decline reply, both relayed 1:1.
  | { type: 'knock'; to: string }
  | { type: 'knock-reply'; to: string; accept: boolean }
  // An emoji reaction, broadcast to the whole workspace (whitelist-validated)
  // and rendered as a short-lived bubble above the sender's avatar.
  | { type: 'reaction'; emoji: string }
  // SFU: announce/replace the tracks this client has published to its Cloudflare
  // session, so the server can relay them to the group as a track directory.
  | { type: 'sfu-publish'; sessionId: string; tracks: SfuTrack[] };

export type ServerMessage =
  | { type: 'auth-error'; message: string }
  // `token` is the short-lived media token required on /api/turn-credentials and
  // /api/sfu/* (see core/media-auth.ts). Refreshed on every (re)connect.
  | {
      type: 'welcome';
      self: Player;
      players: Player[];
      bootId: string;
      sfuEnabled: boolean;
      token: string;
    }
  | { type: 'player-joined'; player: Player }
  | { type: 'player-moved'; userId: string; x: number; y: number; vx: number; vy: number }
  // A peer's new avatar configuration, relayed from their `outfit-update`.
  | { type: 'outfit-update'; userId: string; outfit: Outfit }
  | {
      type: 'player-status';
      userId: string;
      status: PlayerStatus;
      isMuted: boolean;
      isVideoOn: boolean;
      note?: string;
      until?: number | null;
    }
  | { type: 'player-left'; userId: string }
  | { type: 'signal'; from: string; data: SignalData }
  | { type: 'stream-meta'; from: string; streamId: string; kind: StreamKind | 'removed' }
  // A chat line from a proximity-group peer (from === self when it's the echo
  // of our own message). `name` is the sender's display name; `ts` is server ms.
  | { type: 'chat'; from: string; name: string; text: string; ts: number }
  // An incoming knock, and the reply to a knock we sent.
  | { type: 'knock'; from: string; name: string }
  | { type: 'knock-reply'; from: string; name: string; accept: boolean }
  // An emoji reaction from a workspace peer (from === self for our own echo),
  // shown floating above that user's avatar.
  | { type: 'reaction'; userId: string; emoji: string }
  // SFU: the recipient's current proximity group and its transport. The client
  // talks to exactly these members (members includes self) via mesh or SFU.
  // Meeting-room groups are always 'sfu'; outdoor groups promote at 5 and latch.
  | { type: 'group-update'; method: GroupMethod; members: string[] }
  // SFU: a group peer's published track directory, so the recipient can pull
  // their tracks by (sessionId, trackName).
  | { type: 'sfu-peer-tracks'; userId: string; sessionId: string; tracks: SfuTrack[] };

// Compact floor to keep walking short. Must equal MAP_COLS/ROWS × TILE_SIZE in
// world/tilemap.ts (34×24 tiles) and match the server's MAP_WIDTH/HEIGHT.
export const MAP_WIDTH = 1700;
export const MAP_HEIGHT = 1200;
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
