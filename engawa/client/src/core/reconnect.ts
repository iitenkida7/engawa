// Pure reconnect-backoff helpers (issue #126). The App owns the socket and the
// retry schedule; the delay math lives here so it can be unit-tested without
// timers or a real WebSocket. Same "extract the pure decision into a module and
// test it" pattern as proximity.ts / reload.ts.
//
// The original behaviour was a fixed 2s retry with no ceiling; #126 added the
// exponential backoff (base × 2^attempt), the delay cap, and jitter so a fleet
// of clients doesn't reconnect in lockstep after a blip. #183 removed the "give
// up after N attempts" cap: an office tab must survive a router reboot or a
// multi-minute ISP blip unattended, so past RECONNECT_STEADY_AFTER_ATTEMPTS the
// App keeps retrying forever at the RECONNECT_MAX_MS cadence and only escalates
// the toast (with a manual "再接続" button for an immediate attempt).

export const RECONNECT_BASE_MS = 1000;
export const RECONNECT_MAX_MS = 30_000;
// After this many consecutive failures the backoff has reached its ceiling:
// the App switches to the steady RECONNECT_MAX_MS cadence and swaps the toast
// to the stronger "can't connect" one. Retrying never stops (issue #183).
export const RECONNECT_STEADY_AFTER_ATTEMPTS = 8;

// ─── Mesh-peer recovery (issue #184) ─────────────────────────────────────────
// A mesh RTCPeerConnection that dies (ICE failure after a Wi-Fi roam, VPN
// toggle, TURN allocation expiry, …) used to stay dead: the server only re-sends
// group-update on topology changes, so nothing ever recreated the peer. The App
// now schedules a per-peer rebuild with the same capped-backoff math.

// Ceiling for the per-peer rebuild backoff. Shorter than the socket's 30s: a
// call partner missing for half a minute feels broken, and the retry is cheap
// (one signaling exchange), so keep probing.
export const PEER_RETRY_MAX_MS = 15_000;
// 'disconnected' often self-heals within a few seconds (ICE consent renewal
// after a brief blip). Past this, tear the peer down and let the recovery loop
// rebuild it rather than waiting for a 'failed' that can take ~15-30s.
export const PEER_DISCONNECTED_TIMEOUT_MS = 7_000;
// A (re)created peer that never reaches 'connect' within this window is stuck
// (lost offer, one-sided death). Tear it down; the recovery loop retries with a
// higher attempt count.
export const PEER_CONNECT_STALL_MS = 20_000;

// Delay before rebuild attempt N (1-based) of a mesh peer. Same equal-jitter
// backoff as the socket, with the lower ceiling.
export function computePeerRetryDelay(attempt: number, rand: number = Math.random()): number {
  return computeReconnectDelay(Math.max(0, attempt - 1), rand, { maxMs: PEER_RETRY_MAX_MS });
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

// Delay (ms) before the next reconnect for a zero-based `attempt` count. `rand`
// is injected (defaults to Math.random) so tests are deterministic. Uses "equal
// jitter": half of the capped backoff is fixed, the other half is random, so the
// result is always within [capped/2, capped] — spread out but never above the
// ceiling.
export function computeReconnectDelay(
  attempt: number,
  rand: number = Math.random(),
  opts: { baseMs?: number; maxMs?: number } = {},
): number {
  const baseMs = opts.baseMs ?? RECONNECT_BASE_MS;
  const maxMs = opts.maxMs ?? RECONNECT_MAX_MS;
  const exp = baseMs * 2 ** Math.max(0, attempt);
  const capped = Math.min(maxMs, exp);
  const half = capped / 2;
  return Math.round(half + half * clamp01(rand));
}
