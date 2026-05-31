export type Player = {
  userId: string;
  name: string;
  x: number;
  y: number;
};

export type SignalData = unknown;

export type StreamKind = 'mic' | 'cam' | 'screen';

export type GroupMethod = 'mesh' | 'sfu';

// One published SFU track in the per-user directory the server relays so peers
// can pull each other (kind → Cloudflare trackName).
export type SfuTrack = { kind: StreamKind; trackName: string };

export type PlayerStatus = 'online' | 'busy' | 'away' | 'meeting' | 'break';

export type ClientMessage =
  | { type: 'join'; name: string; workspace: string; password?: string }
  | { type: 'move'; x: number; y: number; vx: number; vy: number; zoneId?: string | null }
  // `note` is an optional free-text one-liner; `until` an optional return time
  // (absolute epoch ms, null = none). Relayed with the status, never stored (#85).
  | { type: 'status'; status: PlayerStatus; isMuted: boolean; isVideoOn: boolean; note?: string; until?: number | null }
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
  | { type: 'player-status'; userId: string; status: PlayerStatus; isMuted: boolean; isVideoOn: boolean; note?: string; until?: number | null }
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
  // SFU track directory for this connection (null = hasn't published). Relayed
  // to group peers for pulling. Transient: dropped on disconnect / restart.
  sfuSessionId: string | null;
  sfuTracks: SfuTrack[];
  // Signature (method + sorted members) of the last group-update sent to this
  // client, so we only re-send when it actually changes.
  groupKey: string | null;
  joined: boolean;
};
