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

export type PlayerStatus = 'online' | 'busy' | 'away';

export type ClientMessage =
  // `workspace` is legacy (single-space now); the client no longer sends it and
  // the server defaults it to a single constant. `password` gates entry when an
  // access password is configured. `resumeToken` (issue #187) is the token from
  // the previous welcome: within the leave-grace window it lets a reconnect
  // adopt the previous connection's identity instead of joining fresh.
  | {
      type: 'join';
      name: string;
      workspace?: string;
      password?: string;
      outfit?: Outfit;
      resumeToken?: string;
      // Preferred spawn (client's last position); honoured only when it's clear of
      // others, else the normal spawn is used.
      spawn?: { x: number; y: number };
    }
  // Avatar appearance changed; relayed to the workspace (sanitized, never stored).
  | { type: 'outfit-update'; outfit: Outfit }
  | {
      type: 'move';
      x: number;
      y: number;
      vx: number;
      vy: number;
      zoneId?: string | null;
      // On an open-office desk seat: shrinks this member's proximity bubble.
      seated?: boolean;
    }
  | {
      type: 'status';
      status: PlayerStatus;
      isMuted: boolean;
      isVideoOn: boolean;
      // The camera was paused by the sender's network ladder (tier 3), not by
      // hand — peers show why the tile went dark (issue #312). Optional so
      // older clients still validate.
      camAutoOff?: boolean;
    }
  | { type: 'signal'; to: string; data: SignalData }
  | { type: 'stream-meta'; to: string; streamId: string; kind: StreamKind | 'removed' }
  // Mesh-peer recovery (issue #184): the non-initiator side of a dead pair asks
  // the elected initiator to rebuild it. Relayed 1:1 like signal.
  | { type: 'rtc-restart'; to: string }
  // A knock (call request) and its accept/decline reply, both relayed 1:1.
  | { type: 'knock'; to: string }
  | { type: 'knock-reply'; to: string; accept: boolean }
  // An emoji reaction, broadcast to the whole workspace (whitelist-validated)
  // and rendered as a short-lived bubble above the sender's avatar.
  | { type: 'reaction'; emoji: string }
  // Speaking state change (debounced): relayed to the workspace so everyone can
  // see a speech bubble over a talker on the map, even out of their call.
  | { type: 'speaking'; speaking: boolean }
  // Recording state change (privacy): relayed to the workspace so others in the
  // same call learn someone is recording.
  | { type: 'recording'; recording: boolean }
  // SFU: announce/replace the tracks this client has published to its Cloudflare
  // session, so the server can relay them to the group as a track directory.
  | { type: 'sfu-publish'; sessionId: string; tracks: SfuTrack[] }
  // App-level heartbeat (issue #183): the client pings on a fixed cadence and
  // treats a missing pong as a dead socket (browsers expose no protocol ping).
  | { type: 'ping' };

export type ServerMessage =
  | { type: 'auth-error'; message: string }
  // Heartbeat reply to a client `ping`.
  | { type: 'pong' }
  // `token` is a short-lived, per-connection media token the client must present
  // on /api/turn-credentials and /api/sfu/* (transient, minted on join). It gates
  // consumption of the billable Cloudflare endpoints to live joined sessions.
  // `resumeToken` lets the next reconnect resume this identity (issue #187);
  // `resumed` marks a welcome that DID resume — same userId, position and group
  // kept, so the client skips its session reset and keeps live calls.
  | {
      type: 'welcome';
      self: Player;
      players: Player[];
      bootId: string;
      sfuEnabled: boolean;
      token: string;
      resumeToken: string;
      resumed?: boolean;
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
      camAutoOff: boolean;
    }
  | { type: 'player-left'; userId: string }
  | { type: 'signal'; from: string; data: SignalData }
  | { type: 'stream-meta'; from: string; streamId: string; kind: StreamKind | 'removed' }
  // A group peer asks the recipient (their elected initiator) to rebuild the pair.
  | { type: 'rtc-restart'; from: string }
  // An incoming knock, and the reply to a knock we sent.
  | { type: 'knock'; from: string; name: string }
  | { type: 'knock-reply'; from: string; name: string; accept: boolean }
  // An emoji reaction from a workspace peer (from === self for our own echo),
  // shown floating above that user's avatar.
  | { type: 'reaction'; userId: string; emoji: string }
  // A workspace peer's speaking state changed; drives the on-map speech bubble.
  | { type: 'player-speaking'; userId: string; speaking: boolean }
  // A workspace peer's recording state changed; the client shows it only for a
  // peer currently in its call.
  | { type: 'player-recording'; userId: string; name: string; recording: boolean }
  // SFU: the recipient's current proximity group and its transport. The client
  // talks to exactly these members (members includes self) via mesh or SFU.
  // Meeting-room groups are always 'sfu'; outdoor groups promote at 4 and latch.
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
  // Whether the client is on an open-office desk seat (a private one-person
  // spot). Reported on every `move`; shrinks this member's proximity bubble.
  seated: boolean;
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
  // Cloudflare-backed HTTP endpoints; removed from the valid-token set when the
  // leave is finalized (kept through the resume-grace window, issue #187).
  mediaToken: string | null;
  // Session-resume token minted on join / rotated on resume (issue #187).
  // Presented by the next reconnect's join to adopt this identity within the
  // grace window. Transient, memory-only (invariant #2).
  resumeToken: string | null;
  // Last time (ms) this connection triggered a proximity-group recompute, so a
  // burst of `move` messages from one socket can't force the O(n²) recompute at
  // wire speed. Position updates and player-moved broadcasts are never throttled.
  lastGroupAt: number;
  // Last time (ms) this connection's position actually changed. Proximity uses it
  // to tell "walking past" from "standing still": a new open-floor conversation
  // only starts once both sides have stopped (logic.ts PROXIMITY_STILL_MS).
  lastMoveAt: number;
  joined: boolean;
  // Away mode (#220): a joined client that has stepped away. Stays connected and
  // keeps receiving broadcasts, but is hidden from peers (treated like a leave:
  // removed from their view and from proximity grouping) until it returns to
  // online/busy. Transient, memory-only (invariant #2).
  away: boolean;
};
