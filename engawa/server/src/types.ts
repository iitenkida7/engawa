export type Player = {
  userId: string;
  name: string;
  x: number;
  y: number;
};

export type SignalData = unknown;

export type StreamKind = 'mic' | 'cam' | 'screen';

export type PlayerStatus = 'online' | 'busy' | 'away';

export type ClientMessage =
  | { type: 'join'; name: string; workspace: string; password?: string }
  | { type: 'move'; x: number; y: number; vx: number; vy: number }
  | { type: 'status'; status: PlayerStatus; isMuted: boolean; isVideoOn: boolean }
  | { type: 'signal'; to: string; data: SignalData }
  | { type: 'stream-meta'; to: string; streamId: string; kind: StreamKind | 'removed' };

export type ServerMessage =
  | { type: 'auth-error'; message: string }
  | { type: 'welcome'; self: Player; players: Player[] }
  | { type: 'player-joined'; player: Player }
  | { type: 'player-moved'; userId: string; x: number; y: number; vx: number; vy: number }
  | { type: 'player-status'; userId: string; status: PlayerStatus; isMuted: boolean; isVideoOn: boolean }
  | { type: 'player-left'; userId: string }
  | { type: 'signal'; from: string; data: SignalData }
  | { type: 'stream-meta'; from: string; streamId: string; kind: StreamKind | 'removed' };

export type WsData = {
  userId: string;
  name: string;
  workspace: string;
  x: number;
  y: number;
  joined: boolean;
};
