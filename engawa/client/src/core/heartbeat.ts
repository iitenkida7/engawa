// Pure heartbeat / dead-socket decisions (issue #183). The NetworkClient owns
// the socket and the timestamps; the judgement of "ping now / declare it dead /
// keep waiting" lives here so it is unit-testable without sockets or timers —
// the same pattern as reconnect.ts.
//
// Why an app-level heartbeat at all: when a network path dies silently (Wi-Fi
// roam, sleep/resume, NAT rebind) the browser's WebSocket stays OPEN for
// minutes — no 'close' fires, so the reconnect logic never starts and sends
// vanish. Browsers don't expose protocol-level ping/pong, so the client sends
// its own `ping` message and expects the server's `pong`; silence past the
// timeout means the socket is dead and must be force-closed so the normal
// reconnect path takes over.

// Cadence of client pings. 5s keeps NAT/proxy mappings warm and bounds the
// detection delay without meaningful traffic (a ping is ~20 bytes).
export const HEARTBEAT_PING_INTERVAL_MS = 5_000;

// Silence threshold: no pong (and no open) for this long declares the socket
// dead. Just over two missed pings — short enough that a resume-token reconnect
// (issue #187) still lands inside the server's leave-grace window.
export const HEARTBEAT_PONG_TIMEOUT_MS = 12_000;

// How long a socket may sit in CONNECTING before the attempt is abandoned. A
// SYN blackhole otherwise pins the state machine: isConnected() stays true, so
// neither the visibility handler nor the retry loop will touch it.
export const CONNECT_TIMEOUT_MS = 10_000;

export type HeartbeatPhase = 'connecting' | 'open' | 'idle';

export type HeartbeatInput = {
  phase: HeartbeatPhase;
  // Time spent in CONNECTING (only meaningful for phase 'connecting').
  connectingMs: number;
  // Since the last ping was sent (Infinity if none this connection).
  sincePingMs: number;
  // Since the last pong — or the open, before the first pong (Infinity if unknown).
  sincePongMs: number;
};

export type HeartbeatAction = 'none' | 'send-ping' | 'timeout';

// Decide what one heartbeat tick should do. 'timeout' means the caller should
// force-close the socket (firing the normal close → reconnect path).
export function heartbeatAction(
  inp: HeartbeatInput,
  opts: { pingIntervalMs?: number; pongTimeoutMs?: number; connectTimeoutMs?: number } = {},
): HeartbeatAction {
  const pingIntervalMs = opts.pingIntervalMs ?? HEARTBEAT_PING_INTERVAL_MS;
  const pongTimeoutMs = opts.pongTimeoutMs ?? HEARTBEAT_PONG_TIMEOUT_MS;
  const connectTimeoutMs = opts.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;

  if (inp.phase === 'connecting') {
    return inp.connectingMs > connectTimeoutMs ? 'timeout' : 'none';
  }
  if (inp.phase !== 'open') return 'none';
  if (inp.sincePongMs > pongTimeoutMs) return 'timeout';
  if (inp.sincePingMs >= pingIntervalMs) return 'send-ping';
  return 'none';
}
