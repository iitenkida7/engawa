// Pure reconnect-backoff helpers (issue #126). The App owns the socket and the
// retry timer; the delay math lives here so it can be unit-tested without timers
// or a real WebSocket. Same "extract the pure decision into a module and test
// it" pattern as proximity.ts / reload.ts.
//
// The old behaviour was a fixed 2s retry with no ceiling, which hammered a
// downed server forever. Instead we back off exponentially (base × 2^attempt),
// cap the delay, add jitter so a fleet of clients doesn't reconnect in lockstep
// after a blip, and give up auto-retrying after a bounded number of attempts
// (the App then offers a manual "再接続" button).

export const RECONNECT_BASE_MS = 1000;
export const RECONNECT_MAX_MS = 30_000;
// After this many consecutive failed attempts the App stops auto-retrying and
// surfaces a manual retry instead, so a long-down server isn't pinged forever.
export const RECONNECT_MAX_ATTEMPTS = 8;

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
