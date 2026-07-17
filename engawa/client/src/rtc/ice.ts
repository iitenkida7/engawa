import { mediaAuthHeaders } from '@/core/media-auth';

// Shared ICE-server fetch for both transports (mesh WebRtcManager and SfuManager),
// so the credentials are fetched once and refreshed on a TTL instead of being
// cached for the whole page lifetime. The server issues Cloudflare TURN
// credentials with ttl 3600s (server/src/turn.ts); an all-day office tab that
// cached them forever would build every NEW PeerConnection after an hour with
// expired TURN creds and silently fail behind strict NAT. Refetch at half-life.

const STUN_FALLBACK: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }];

// Refresh window (ms) — half of the server's 3600s TURN TTL.
export const ICE_TTL_MS = 30 * 60 * 1000;

let cache: { servers: RTCIceServer[]; fetchedAt: number } | null = null;
let inflight: Promise<RTCIceServer[]> | null = null;

// Reset the module cache (tests only).
export function resetIceCache(): void {
  cache = null;
  inflight = null;
}

// Fetch (or return the still-fresh cached) ICE servers. Concurrent callers during
// the first fetch share one request. A transient failure returns the STUN-only
// fallback WITHOUT caching it, so the next call retries rather than latching
// STUN-only for the page lifetime. `now` is injectable for deterministic tests.
export async function fetchIceServers(now: () => number = Date.now): Promise<RTCIceServer[]> {
  if (cache && now() - cache.fetchedAt < ICE_TTL_MS) return cache.servers;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const res = await fetch('/api/turn-credentials', { headers: mediaAuthHeaders() });
      if (!res.ok) throw new Error(`turn-credentials HTTP ${res.status}`);
      const body = (await res.json()) as unknown;
      // Guard the shape before it reaches RTCPeerConnection: a non-array error
      // body (e.g. a 401 JSON object slipping past) would poison the config.
      if (!Array.isArray(body)) throw new Error('turn-credentials: not an array');
      cache = { servers: body as RTCIceServer[], fetchedAt: now() };
      return cache.servers;
    } catch (err) {
      console.error('[rtc] failed to fetch ice servers', err);
      return STUN_FALLBACK;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}
