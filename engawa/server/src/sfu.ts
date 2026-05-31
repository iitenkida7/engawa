// Cloudflare Realtime SFU control-plane proxy.
//
// The app id and app token are read from the environment and injected here so
// the browser never sees them — same rule as the TURN credentials (invariant
// #3: Cloudflare keys stay server-side). Clients call our /api/sfu/* routes,
// which forward to Cloudflare with the bearer token attached. Media never flows
// through this proxy; it relays signaling (SDP offer/answer, track ops) only,
// so the no-media-through-our-server invariant (#1) holds.

const CLOUDFLARE_REALTIME_BASE = 'https://rtc.live.cloudflare.com/v1';

// Allowed session sub-paths (everything after .../sessions). Whitelisted so the
// proxy can never be coerced into hitting an arbitrary Cloudflare URL. The
// session-id segment is restricted to alphanumerics/`_`/`-` (no dots, so it
// cannot smuggle a `..` path-traversal segment).
const ALLOWED_SESSION_PATHS = [
  /^\/new$/,
  /^\/[A-Za-z0-9_-]+\/tracks\/new$/,
  /^\/[A-Za-z0-9_-]+\/renegotiate$/,
  /^\/[A-Za-z0-9_-]+\/tracks\/update$/,
  /^\/[A-Za-z0-9_-]+\/tracks\/close$/,
];

// True when both the app id and token are configured. When false the whole SFU
// feature is disabled and every proximity group falls back to mesh, so the app
// behaves exactly as it did before SFU support (no new hard dependency).
export function isSfuEnabled(): boolean {
  return Boolean(
    process.env.CLOUDFLARE_REALTIME_APP_ID && process.env.CLOUDFLARE_REALTIME_APP_TOKEN,
  );
}

// Pure guard: is this session sub-path one of the documented control-plane
// endpoints? Used by the router before forwarding (SSRF / traversal guard).
export function isAllowedSessionPath(sessionPath: string): boolean {
  return ALLOWED_SESSION_PATHS.some((re) => re.test(sessionPath));
}

export type SfuProxyResult = { status: number; body: unknown };

/**
 * Forward one SFU control-plane request to Cloudflare Realtime, attaching the
 * app id (path) and app token (bearer) server-side. `sessionPath` is the part
 * after .../sessions (e.g. "/new", "/<sid>/tracks/new") and must already pass
 * isAllowedSessionPath. The upstream JSON status/body are returned verbatim.
 */
export async function proxySfuRequest(
  method: string,
  sessionPath: string,
  body: unknown,
): Promise<SfuProxyResult> {
  const appId = process.env.CLOUDFLARE_REALTIME_APP_ID;
  const token = process.env.CLOUDFLARE_REALTIME_APP_TOKEN;
  if (!appId || !token) {
    return {
      status: 503,
      body: { errorCode: 'sfu_disabled', errorDescription: 'SFU not configured' },
    };
  }

  try {
    const res = await fetch(`${CLOUDFLARE_REALTIME_BASE}/apps/${appId}/sessions${sessionPath}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: unknown = {};
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = { raw: text };
      }
    }
    return { status: res.status, body: parsed };
  } catch (err) {
    console.error('[sfu] proxy error', err);
    return {
      status: 502,
      body: { errorCode: 'sfu_upstream', errorDescription: 'SFU upstream error' },
    };
  }
}
