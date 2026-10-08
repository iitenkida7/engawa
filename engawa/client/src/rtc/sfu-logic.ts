import type { GroupMethod, SfuTrack, StreamKind } from '@/core/types';

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

// Pair each requested pull with its per-track result from a batched tracks/new
// response (issue #254): { mid } when it came back routable, { error } when it
// didn't (see sfuTrackError). Entries are matched by (sessionId, trackName)
// when the SFU echoes them, falling back to request order otherwise.
export function matchPullResults(
  requested: { sessionId: string; trackName: string }[],
  tracks: { mid?: string; sessionId?: string; trackName?: string; errorCode?: string }[] = [],
): ({ mid: string } | { error: string })[] {
  return requested.map((req, idx) => {
    const t =
      tracks.find((r) => r.sessionId === req.sessionId && r.trackName === req.trackName) ??
      tracks[idx];
    const err = sfuTrackError({ tracks: t ? [t] : [] });
    return err ? { error: err } : { mid: t!.mid! };
  });
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

// Per-attempt deadline for one control-plane request (issue #194). Without it a
// half-open TCP connection or a stuck proxy leaves fetch pending forever: the
// serialized op chain stalls every later push/pull and onFailed never fires, so
// the call neither recovers nor falls back. A timeout counts as a network error
// (retried, then the normal failure path).
export const SFU_API_TIMEOUT_MS = 10_000;

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

// Retry schedule for a pull the SFU rejected (issue #250). A rejected pull
// (top-level or per-track errorCode on tracks/new) usually means our cached
// directory for that ONE peer is stale — they just rebuilt, or unpublished —
// not that our transport is broken. Failing the whole transport on it made one
// peer's race rebuild everyone (each rebuild changes our session id, racing the
// others' pulls in turn) until the group fell back to mesh. Returns the delay
// before retry N (1-based): 1s, 2s, 4s; null once retries are exhausted.
export const SFU_PULL_MAX_RETRIES = 3;

export function sfuPullRetryDelayMs(retry: number): number | null {
  if (retry < 1 || retry > SFU_PULL_MAX_RETRIES) return null;
  return 1000 * 2 ** (retry - 1);
}

// Delay before the Nth consecutive SFU transport rebuild (issue #254). The
// SFU path never degrades to mesh — mesh is sized for ≤3 people and a one-sided
// fallback left groups half on mesh, half on SFU — so a failing transport is
// rebuilt in place indefinitely: the first at once, then backing off to a cap.
const SFU_REBUILD_DELAYS_MS = [0, 2_000, 5_000, 10_000, 20_000, 30_000];

export function sfuRebuildDelayMs(attempt: number): number {
  const i = Math.min(Math.max(attempt, 1), SFU_REBUILD_DELAYS_MS.length) - 1;
  return SFU_REBUILD_DELAYS_MS[i];
}

// From which consecutive rebuild the "reconnecting to the call server" notice
// shows: a lone quick rebuild only gets the per-tile overlay.
export const SFU_RECONNECT_NOTICE_FROM = 2;

// A failure this long after the transport last connected starts a fresh
// backoff; anything sooner counts as the same outage (a PC that connects and
// then fails straight away must not rebuild at full speed forever).
export const SFU_REBUILD_RESET_MS = 60_000;

// How long after a rebuild connects the frozen pre-rebuild streams are kept
// before any that were not replaced by a re-pull are swept away.
export const SFU_STALE_STREAM_GRACE_MS = 15_000;

// Where a local publish (toolbar mic/cam/screen on, device switch) goes (issue
// #258). While an SFU rebuild is pending the transport must stay closed until
// its deadline: forwarding the publish would reopen it early (new session,
// pulls started) and defeat the backoff. 'defer' drops it — the rebuild
// publishes whatever MediaManager holds by then, so nothing is lost.
export function localPublishRoute(
  method: GroupMethod,
  sfuRebuildPending: boolean,
): 'mesh' | 'sfu' | 'defer' {
  if (method !== 'sfu') return 'mesh';
  return sfuRebuildPending ? 'defer' : 'sfu';
}

// Whether an RTCPeerConnection state change means the SFU transport failed and
// must be rebuilt. Only a hard 'failed' counts ('disconnected' often recovers).
export function isSfuTransportFailed(connectionState: RTCPeerConnectionState): boolean {
  return connectionState === 'failed';
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

// ─── Big-group receive caps (#237/#238) ─────────────────────────────────────
// Pulling every peer's camera and mic in a 23-person all-hands melts CPU and
// downlink. Cap how many of each we receive, choosing the active speakers;
// everyone else is dropped until they speak (activity is known from the relayed
// `speaking` signal, so a dropped peer re-pulls the moment they talk).
export const SFU_MAX_CAM_PULLS = 9; // 3×3 stage of cameras
export const SFU_MAX_MIC_PULLS = 16; // audio is cheap → a looser cap, no clipping in normal meetings

// Pure: pick which peers' cameras to pull, capped at `cap`. Only peers that
// publish a camera are eligible; prefer speaking-now, then most-recently-spoken
// (recency gives stable, non-flappy membership), then userId. <= cap ids; the
// caller treats "all eligible" (<= cap) as no restriction.
export function selectActiveCameras(
  candidates: { userId: string; hasCam: boolean; speaking: boolean; lastSpokeMs: number }[],
  cap: number = SFU_MAX_CAM_PULLS,
): string[] {
  const withCam = candidates.filter((c) => c.hasCam);
  if (withCam.length <= cap) return withCam.map((c) => c.userId);
  return [...withCam]
    .sort(compareBySpeaker)
    .slice(0, cap)
    .map((c) => c.userId);
}

// Pure: pick which peers' mics to pull, capped at `cap`. Same ordering as cameras.
export function selectActiveMics(
  candidates: { userId: string; speaking: boolean; lastSpokeMs: number }[],
  cap: number = SFU_MAX_MIC_PULLS,
): string[] {
  if (candidates.length <= cap) return candidates.map((c) => c.userId);
  return [...candidates]
    .sort(compareBySpeaker)
    .slice(0, cap)
    .map((c) => c.userId);
}

function compareBySpeaker(
  a: { userId: string; speaking: boolean; lastSpokeMs: number },
  b: { userId: string; speaking: boolean; lastSpokeMs: number },
): number {
  return (
    Number(b.speaking) - Number(a.speaking) ||
    b.lastSpokeMs - a.lastSpokeMs ||
    (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0)
  );
}
