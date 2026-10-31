import { entryAuth } from './entry';
import { isPasswordRequired, verifyAccessPassword } from './logic';
import { setting } from './settings';
import {
  isAllowedSessionPath,
  proxySfuRequest as proxySfuRequestDefault,
  type SfuProxyResult,
  isSfuEnabled as sfuEnabledDefault,
} from './sfu';
import { getTurnCredentials as getTurnCredentialsDefault } from './turn';

// Header the client presents on /api/turn-credentials and /api/sfu/*, carrying
// the token from `welcome` (see client core/media-auth.ts).
export const MEDIA_TOKEN_HEADER = 'x-engawa-token';

export type HttpDeps = {
  // Read for /api/health only — the live connection count.
  clients: { readonly size: number };
  // Media tokens minted per connection on a successful join (see websocket.ts).
  mediaTokens: ReadonlySet<string>;
  // The validated map, already serialized at boot.
  mapJson: string;
  // Directory the built client is served from.
  publicDir: string;
  // Seams for the two outbound calls, so tests can exercise the routing
  // without reaching Cloudflare. Production passes none of them.
  getTurnCredentials?: () => Promise<unknown>;
  isSfuEnabled?: () => boolean;
  proxySfuRequest?: (method: string, sessionPath: string, body: unknown) => Promise<SfuProxyResult>;
};

// Built per request on purpose: a Response body can only be read once, so a
// shared instance 500s on every call after the first.
function unauthorized(): Response {
  return Response.json(
    { errorCode: 'unauthorized', errorDescription: 'join required' },
    { status: 401 },
  );
}

/**
 * Everything the server answers over plain HTTP. The websocket upgrade (/ws)
 * stays in index.ts because it needs the Bun server object; everything else is
 * here, where it can be driven by a Request and asserted on.
 */
export function createHttpHandler(deps: HttpDeps): (req: Request) => Promise<Response> {
  const getTurnCredentials = deps.getTurnCredentials ?? getTurnCredentialsDefault;
  const isSfuEnabled = deps.isSfuEnabled ?? sfuEnabledDefault;
  const proxySfuRequest = deps.proxySfuRequest ?? proxySfuRequestDefault;

  function hasValidMediaToken(req: Request): boolean {
    const token = req.headers.get(MEDIA_TOKEN_HEADER);
    return token !== null && deps.mediaTokens.has(token);
  }

  return async function handleHttp(req: Request): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === '/api/turn-credentials') {
      if (!hasValidMediaToken(req)) return unauthorized();
      const iceServers = await getTurnCredentials();
      return Response.json(iceServers, {
        headers: { 'Cache-Control': 'no-store' },
      });
    }

    if (url.pathname === '/api/health') {
      return Response.json({ ok: true, clients: deps.clients.size });
    }

    // The map every client builds its world from (public: it's the floor plan
    // the join screen leads into). Fixed for this process; a restart changes the
    // boot id, which makes connected clients reload and fetch it again.
    if (url.pathname === '/api/map') {
      return new Response(deps.mapJson, {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      });
    }

    // Public pre-join config: which gate this office uses, so the client knows
    // which screen to show. `entryMode: 'token'` means entry is by signed ticket
    // (docs/entry-token.md) and there is no password step — the two gates are
    // exclusive, so an ACCESS_PASSWORD left over in the environment is not
    // reported (nor checked) while tickets are in force. Nothing secret here:
    // it is the same answer for everyone, before anyone has identified
    // themselves. The join over the websocket is the gate that counts.
    if (url.pathname === '/api/config') {
      const mode = entryAuth().mode;
      return Response.json(
        {
          entryMode: mode,
          passwordRequired: mode === 'password' && isPasswordRequired(setting('ACCESS_PASSWORD')),
        },
        { headers: { 'Cache-Control': 'no-store' } },
      );
    }

    // Public password check for the pre-join gate. Reveals only whether the
    // supplied password is correct (open space → always ok). The join over WS
    // re-validates, so this is a UX helper, not the sole gate.
    if (url.pathname === '/api/verify-password') {
      if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
      const body = (await req.json().catch(() => ({}))) as { password?: unknown };
      const password = typeof body.password === 'string' ? body.password : undefined;
      return Response.json(
        { ok: verifyAccessPassword(password, setting('ACCESS_PASSWORD')) },
        { headers: { 'Cache-Control': 'no-store' } },
      );
    }

    // SFU control-plane proxy: forwards to Cloudflare Realtime with the app id +
    // token attached server-side (the browser never sees them). Signaling only —
    // media never traverses our server. The path after /sessions is whitelisted
    // to the documented endpoints (SSRF / traversal guard, see sfu.ts).
    if (url.pathname.startsWith('/api/sfu/sessions')) {
      if (!hasValidMediaToken(req)) return unauthorized();
      if (!isSfuEnabled()) {
        return Response.json(
          { errorCode: 'sfu_disabled', errorDescription: 'SFU disabled' },
          { status: 503 },
        );
      }
      const sessionPath = url.pathname.slice('/api/sfu/sessions'.length);
      if (!isAllowedSessionPath(sessionPath)) {
        return new Response('Not Found', { status: 404 });
      }
      if (req.method !== 'POST' && req.method !== 'PUT') {
        return new Response('Method Not Allowed', { status: 405 });
      }
      const body = await req.json().catch(() => undefined);
      const result = await proxySfuRequest(req.method, sessionPath, body);
      return Response.json(result.body, {
        status: result.status,
        headers: { 'Cache-Control': 'no-store' },
      });
    }

    const reqPath = url.pathname === '/' ? '/index.html' : url.pathname;
    const file = Bun.file(`${deps.publicDir}${reqPath}`);
    if (await file.exists()) {
      return new Response(file);
    }
    // SPA fallback to index.html (in case client uses any client-side routing)
    const indexFile = Bun.file(`${deps.publicDir}/index.html`);
    if ((await indexFile.exists()) && !reqPath.includes('.')) {
      return new Response(indexFile);
    }
    return new Response('Not Found', { status: 404 });
  };
}
