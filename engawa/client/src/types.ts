export type Player = {
  userId: string;
  name: string;
  x: number;
  y: number;
};

export type SignalData = unknown;

export type StreamKind = 'mic' | 'cam' | 'screen';

export type GroupMethod = 'mesh' | 'sfu';

// One published SFU track (kind → Cloudflare trackName) in the per-user track
// directory the server relays so peers can pull each other.
export type SfuTrack = { kind: StreamKind; trackName: string };

export type PlayerStatus = 'online' | 'busy' | 'away' | 'meeting' | 'break';

export type ClientMessage =
  | { type: 'join'; name: string; workspace: string; password?: string }
  | { type: 'move'; x: number; y: number; vx: number; vy: number; zoneId?: string | null }
  | { type: 'status'; status: PlayerStatus; isMuted: boolean; isVideoOn: boolean }
  | { type: 'signal'; to: string; data: SignalData }
  | { type: 'stream-meta'; to: string; streamId: string; kind: StreamKind | 'removed' }
  // A chat line, relayed to the sender's current proximity group (the people
  // they're in a call with), so text stays spatial. The server keeps no history.
  | { type: 'chat'; text: string }
  // A knock (call request) and its accept/decline reply, both relayed 1:1.
  | { type: 'knock'; to: string }
  | { type: 'knock-reply'; to: string; accept: boolean }
  // SFU: announce/replace the tracks this client has published to its Cloudflare
  // session, so the server can relay them to the group as a track directory.
  | { type: 'sfu-publish'; sessionId: string; tracks: SfuTrack[] };

export type ServerMessage =
  | { type: 'auth-error'; message: string }
  | { type: 'welcome'; self: Player; players: Player[]; bootId: string; sfuEnabled: boolean }
  | { type: 'player-joined'; player: Player }
  | { type: 'player-moved'; userId: string; x: number; y: number; vx: number; vy: number }
  | { type: 'player-status'; userId: string; status: PlayerStatus; isMuted: boolean; isVideoOn: boolean }
  | { type: 'player-left'; userId: string }
  | { type: 'signal'; from: string; data: SignalData }
  | { type: 'stream-meta'; from: string; streamId: string; kind: StreamKind | 'removed' }
  // A chat line from a proximity-group peer (from === self when it's the echo
  // of our own message). `name` is the sender's display name; `ts` is server ms.
  | { type: 'chat'; from: string; name: string; text: string; ts: number }
  // An incoming knock, and the reply to a knock we sent.
  | { type: 'knock'; from: string; name: string }
  | { type: 'knock-reply'; from: string; name: string; accept: boolean }
  // SFU: the recipient's current proximity group and its transport. The client
  // talks to exactly these members (members includes self) via mesh or SFU.
  // Meeting-room groups are always 'sfu'; outdoor groups promote at 5 and latch.
  | { type: 'group-update'; method: GroupMethod; members: string[] }
  // SFU: a group peer's published track directory, so the recipient can pull
  // their tracks by (sessionId, trackName).
  | { type: 'sfu-peer-tracks'; userId: string; sessionId: string; tracks: SfuTrack[] };

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
