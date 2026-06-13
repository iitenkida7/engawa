// The wire-protocol types live in ../../shared/protocol.ts — the single source
// of truth shared with the client. They are re-exported here so application
// code (and the tests) keeps importing from './types'.
import type { Outfit, SfuTrack } from '../../shared/protocol';

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
} from '../../shared/protocol';

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
  joined: boolean;
};
