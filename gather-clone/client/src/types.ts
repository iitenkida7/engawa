export type Player = {
  userId: string;
  name: string;
  x: number;
  y: number;
};

export type SignalData = unknown;

export type StreamKind = 'mic' | 'cam' | 'screen';

export type ClientMessage =
  | { type: 'join'; name: string }
  | { type: 'move'; x: number; y: number }
  | { type: 'signal'; to: string; data: SignalData }
  | { type: 'stream-meta'; to: string; streamId: string; kind: StreamKind | 'removed' };

export type ServerMessage =
  | { type: 'welcome'; self: Player; players: Player[] }
  | { type: 'player-joined'; player: Player }
  | { type: 'player-moved'; userId: string; x: number; y: number }
  | { type: 'player-left'; userId: string }
  | { type: 'signal'; from: string; data: SignalData }
  | { type: 'stream-meta'; from: string; streamId: string; kind: StreamKind | 'removed' };

export const MAP_WIDTH = 2000;
export const MAP_HEIGHT = 1500;
export const PLAYER_RADIUS = 20;
export const PLAYER_SPEED = 3.5;
export const CONNECT_RADIUS = 200;
export const DISCONNECT_RADIUS = 250;
export const POSITION_SEND_INTERVAL_MS = 100;
