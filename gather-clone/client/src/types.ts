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

export const MAP_WIDTH = 2000;
export const MAP_HEIGHT = 1500;
export const PLAYER_RADIUS = 20;
// Pixels per second. Frame-rate independent; the per-frame delta is computed
// with the actual dt of each frame.
export const PLAYER_SPEED = 210;
export const CONNECT_RADIUS = 200;
export const DISCONNECT_RADIUS = 250;
export const POSITION_SEND_INTERVAL_MS = 50;
// How aggressively remote players are pulled toward their predicted position
// each frame. Higher = snappier but more jitter on noisy networks.
// alpha_per_60fps_frame ≈ 1 - exp(-decay/60). 40 → ~0.49.
export const INTERP_DECAY = 40;
// Cap how far into the future we extrapolate when the network goes silent.
export const EXTRAP_MAX_MS = 200;
