// Modular avatar configuration (#141): an integer index per category. The server
// treats it as opaque data — it only sanitizes (sanitizeOutfit) and relays it,
// never interprets it — so it stays stateless (invariant #2).
export type Outfit = {
  sex: number;
  skin: number;
  hair: number;
  hairColor: number;
  top: number;
  topColor: number;
  bottom: number;
  bottomColor: number;
  shoes: number;
  hat: number;
  glasses: number;
};

export type Player = {
  userId: string;
  name: string;
  x: number;
  y: number;
  outfit: Outfit;
};

export type SignalData = unknown;

export type StreamKind = 'mic' | 'cam' | 'screen';

export type GroupMethod = 'mesh' | 'sfu';

// One published SFU track in the per-user directory the server relays so peers
// can pull each other (kind → Cloudflare trackName).
export type SfuTrack = { kind: StreamKind; trackName: string };

export type PlayerStatus = 'online' | 'busy' | 'away' | 'meeting' | 'break';

export type ClientMessage =
  | { type: 'join'; name: string; workspace: string; password?: string; outfit?: Outfit }
  // Avatar appearance changed; relayed to the workspace (sanitized, never stored).
  | { type: 'outfit-update'; outfit: Outfit }
  | { type: 'move'; x: number; y: number; vx: number; vy: number; zoneId?: string | null }
  // `note` is an optional free-text one-liner; `until` an optional return time
  // (absolute epoch ms, null = none). Relayed with the status, never stored (#85).
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
  // `token` is a short-lived, per-connection media token the client must present
  // on /api/turn-credentials and /api/sfu/* (transient, minted on join). It gates
  // consumption of the billable Cloudflare endpoints to live joined sessions.
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

export type WsData = {
  userId: string;
  name: string;
  workspace: string;
  x: number;
  y: number;
  // Last reported meeting-room zone id (null = open floor). Reported by the
  // client on every `move`; drives server-side proximity grouping.
  zoneId: string | null;
  // Modular avatar configuration (#141). Sanitized on join / outfit-update and
  // relayed to peers; transient, reset on restart (invariant #2).
  outfit: Outfit;
  // SFU track directory for this connection (null = hasn't published). Relayed
  // to group peers for pulling. Transient: dropped on disconnect / restart.
  sfuSessionId: string | null;
  sfuTracks: SfuTrack[];
  // Signature (method + sorted members) of the last group-update sent to this
  // client, so we only re-send when it actually changes.
  groupKey: string | null;
  // Short-lived media token minted on join (null until joined). Required on the
  // Cloudflare-backed HTTP endpoints; removed from the valid-token set on close.
  mediaToken: string | null;
  // Last time (ms) this connection triggered a proximity-group recompute, so a
  // burst of `move` messages from one socket can't force the O(n²) recompute at
  // wire speed. Position updates and player-moved broadcasts are never throttled.
  lastGroupAt: number;
  joined: boolean;
};
