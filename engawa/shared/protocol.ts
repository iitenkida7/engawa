// The WebSocket wire protocol shared by the server (engawa/server) and the
// client (engawa/client) — the single source of truth for every message that
// crosses the socket. Both packages re-export these from their own types
// module (server/src/types.ts, client/src/core/types.ts), so application code
// never imports this file directly.
//
// This file is type-only (everything erases at compile time): the server
// type-checks it via its tsconfig include, the client via tsconfig + the
// @shared alias, and the docker setup mounts the whole engawa/ tree so the
// relative path resolves identically on the host and in the containers.

// One avatar configuration (#141): an integer index per category. Parts
// (hair/top/…) index into the client manifest's part lists; the *Color fields
// index into a shared palette (skin→body palette, hairColor→hair palette,
// top/bottomColor→cloth). A handful of small integers, so the whole thing
// relays as JSON — the server only sanitizes (sanitizeOutfit) and forwards it,
// never interprets it, staying stateless (invariant #2).
export type Outfit = {
  sex: number; // 0 = male, 1 = female (selects body/head/face + bodytype paths)
  skin: number; // body palette color index (applied to body/head/face)
  hair: number; // hair part index (0 = none)
  hairColor: number; // hair palette color index
  top: number; // torso part index
  topColor: number; // cloth palette color index
  bottom: number; // legs part index
  bottomColor: number; // cloth palette color index
  shoes: number; // feet part index (0 = barefoot)
  hat: number; // headwear part index (0 = none)
  glasses: number; // glasses part index (0 = none)
};

export type Player = {
  userId: string;
  name: string;
  x: number;
  y: number;
  // Modular avatar configuration (#141). Optional so a peer/server that omits
  // it (or an older client) still parses; the client renderer falls back to
  // defaults, while the server always populates it on relay.
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
  // re-render this avatar (sanitized, never stored — invariant #2).
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
  | { type: 'welcome'; self: Player; players: Player[]; bootId: string; sfuEnabled: boolean }
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
