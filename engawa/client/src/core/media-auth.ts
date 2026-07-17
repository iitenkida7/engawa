// Short-lived media token issued by the server in `welcome` and required on the
// Cloudflare-backed media endpoints (/api/turn-credentials, /api/sfu/*). Held in
// memory only and refreshed on every (re)connect, so it stays consistent with
// the stateless-server invariant. Both transports (rtc/webrtc.ts, rtc/sfu.ts)
// attach it via mediaAuthHeaders(); core/app.ts sets it from the welcome message.

let token: string | null = null;

export function setMediaToken(next: string | null): void {
  token = next;
}

// Fetch headers carrying the media token, or an empty object before we've joined
// (so a pre-join/unauthenticated fetch simply omits it and gets a 401).
export function mediaAuthHeaders(): Record<string, string> {
  return token ? { 'X-Engawa-Token': token } : {};
}
