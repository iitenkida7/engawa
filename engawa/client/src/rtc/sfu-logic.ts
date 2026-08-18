import type { SfuTrack, StreamKind } from '@/core/types';

// Pure decision helpers for the SFU transport (issue #129). SfuManager / App
// own the browser-API state (RTCPeerConnection, fetch, Maps); the judgements
// that decide *what* to do live here so they can be unit-tested without mocking
// WebRTC. Same "extract pure logic into a module and test it" pattern the rest
// of the codebase uses (logic.ts / proximity.ts / cam-bitrate.ts).

// Key used to index a pulled remote track by (peer, kind). The kind is unique
// per peer (a peer publishes at most one mic / cam / screen), so this is enough
// to dedupe pulls and route drops.
export const remoteKey = (userId: string, kind: StreamKind): string => `${userId}/${kind}`;

// Interpret a Cloudflare tracks/* response: null when it succeeded, otherwise a
// human-readable error string. SfuManager throws on a non-null result, which
// rejects the op chain (logged, not fatal) rather than corrupting PC state.
export function sfuErrorMessage(resp: {
  errorCode?: string;
  errorDescription?: string;
}): string | null {
  if (!resp.errorCode) return null;
  return resp.errorDescription ?? resp.errorCode;
}

// Interpret the per-track result of a tracks/new (pull) response: null when the
// single track came back cleanly with a routable mid, otherwise the reason it
// failed. Cloudflare can report a per-track failure (e.g. pulling a trackName the
// publisher's session no longer has) inside resp.tracks[] with a 200 top-level
// status and no mid — SfuManager must throw on that instead of storing an
// unroutable entry that would silently give no media and block every re-pull.
export function sfuTrackError(resp: {
  tracks?: { mid?: string; errorCode?: string }[];
}): string | null {
  const t = resp.tracks?.[0];
  if (!t) return 'no track in response';
  if (t.errorCode) return t.errorCode;
  if (!t.mid) return 'no mid';
  return null;
}

// Interpret a session/new response: null when a session id came back, otherwise
// the reason creation failed. A missing id with no description still fails.
export function sfuSessionError(resp: {
  sessionId?: string;
  errorDescription?: string;
}): string | null {
  if (resp.sessionId) return null;
  return resp.errorDescription ?? 'no id';
}

// ─── Control-plane retry policy (issue #186) ────────────────────────────────
// One transient HTTP failure (a blip mid-op, a lone 502) used to degrade the
// whole group to mesh — the worst possible response to a struggling network
// (n² streams). Retryable failures are retried with a short backoff inside
// SfuManager.api(); only exhausted retries reach the fallback.

export const SFU_API_MAX_ATTEMPTS = 3;

// Delay before retrying failed attempt N (1-based): 500ms, 1s.
export function sfuApiRetryDelayMs(attempt: number): number {
  return 500 * 2 ** Math.max(0, attempt - 1);
}

// Which HTTP outcomes are worth retrying. 'network' = fetch itself failed.
// 401 is retryable because a WS reconnect re-mints the media token (the retry
// picks the fresh one up); 4xx otherwise means the request itself is wrong and
// a retry can't help. 5xx/408/429 are the classic transients.
export function isRetryableSfuHttp(status: number | 'network'): boolean {
  if (status === 'network') return true;
  return status === 401 || status === 408 || status === 429 || status >= 500;
}

// Minimum spacing between whole-transport rebuild attempts (App.onSfuFailed):
// the first failure rebuilds the SFU session in place; a second failure inside
// this window means the SFU path really is unhealthy → degrade to mesh.
export const SFU_REBUILD_MIN_INTERVAL_MS = 30_000;

// Whether an RTCPeerConnection state change should trigger the mesh fallback.
// Only a hard 'failed' degrades the call, and never after we deliberately
// closed the transport (closeAll sets closed=true, which also closes the PC and
// can surface a late 'failed' we must ignore).
export function shouldFallbackToMesh(
  connectionState: RTCPeerConnectionState,
  closed: boolean,
): boolean {
  return connectionState === 'failed' && !closed;
}

// Diff a peer's announced track directory against what we've already pulled:
// `toPull` are tracks we don't have yet, `toDrop` are remote keys for this peer
// that disappeared (e.g. they turned their camera off). Keys for *other* peers
// are left untouched. Drives SfuManager.setPeerTracks.
export function reconcilePeerTracks(
  userId: string,
  tracks: SfuTrack[],
  currentKeys: Iterable<string>,
): { toPull: SfuTrack[]; toDrop: string[] } {
  const desired = new Set(tracks.map((t) => remoteKey(userId, t.kind)));
  const have = new Set(currentKeys);
  const toPull = tracks.filter((t) => !have.has(remoteKey(userId, t.kind)));
  const toDrop: string[] = [];
  for (const key of have) {
    if (key.startsWith(`${userId}/`) && !desired.has(key)) toDrop.push(key);
  }
  return { toPull, toDrop };
}

// Chain one renegotiation op after the previous one against the single SFU
// PeerConnection. Every op is serialized (the SFU mutates one PC, so concurrent
// offer/answer would race), skipped once the transport is closed, and its
// failure is isolated so it can't break the chain for the next op. Returns the
// new tail of the chain.
export function chainOp(
  chain: Promise<void>,
  isClosed: () => boolean,
  op: () => Promise<void>,
  onError: (err: unknown) => void,
): Promise<void> {
  return chain.then(() => (isClosed() ? undefined : op())).catch(onError);
}

// Reconcile a set of currently-connected ids against the group the server says
// we should be in: `toClose` are connections to tear down (gone from the group),
// `toOpen` are members we have no connection to yet. Used for both the mesh peer
// set and the SFU track-directory peer set when a group-update arrives.
export function partitionMembers(
  currentIds: Iterable<string>,
  desiredIds: Set<string>,
): { toClose: string[]; toOpen: string[] } {
  const current = new Set(currentIds);
  const toClose = [...current].filter((id) => !desiredIds.has(id));
  const toOpen = [...desiredIds].filter((id) => !current.has(id));
  return { toClose, toOpen };
}
