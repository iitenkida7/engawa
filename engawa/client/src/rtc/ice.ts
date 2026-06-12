// Fetch short-lived ICE servers (TURN credentials) from our own server.
// Invariant #3: the Cloudflare keys never reach the browser — the
// /api/turn-credentials endpoint issues short-lived credentials instead. Falls
// back to public STUN so a missing or failing endpoint degrades to STUN-only
// connectivity, not a dead call. Shared by both transports (mesh rtc/webrtc.ts
// and SFU rtc/sfu.ts); each keeps its own per-instance memoizing cache.
// `logPrefix` keeps the two transports' log lines distinguishable.
export async function fetchIceServers(logPrefix: string): Promise<RTCIceServer[]> {
  try {
    const res = await fetch('/api/turn-credentials');
    return (await res.json()) as RTCIceServer[];
  } catch (err) {
    console.error(`${logPrefix} failed to fetch ice servers`, err);
    return [{ urls: 'stun:stun.l.google.com:19302' }];
  }
}
