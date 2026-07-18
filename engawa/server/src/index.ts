import type { ServerWebSocket } from 'bun';
import { isPasswordRequired, verifyAccessPassword } from './logic';
import { isAllowedSessionPath, isSfuEnabled, proxySfuRequest } from './sfu';
import { getTurnCredentials } from './turn';
import type { WsData } from './types';
import { createWebSocketHandler } from './websocket';

const clients = new Map<string, ServerWebSocket<WsData>>();
const PUBLIC_DIR = './public';

// Single optional access password. When unset the space is open (no password is
// ever requested); the client asks /api/config whether to show the gate.
const ACCESS_PASSWORD = process.env.ACCESS_PASSWORD;

// Valid short-lived media tokens, minted per connection on a successful join and
// removed on close (see websocket.ts). Requiring one on the Cloudflare-backed
// endpoints ties consumption of the billable TURN/SFU resources to a live joined
// session, so an anonymous HTTP client can't farm credentials or run sessions.
// Transient in-memory only — reset on restart (invariant #2).
const mediaTokens = new Set<string>();

// Header the client presents on /api/turn-credentials and /api/sfu/*, carrying
// the token from `welcome` (see client core/media-auth.ts).
const MEDIA_TOKEN_HEADER = 'x-engawa-token';

function hasValidMediaToken(req: Request): boolean {
  const token = req.headers.get(MEDIA_TOKEN_HEADER);
  return token !== null && mediaTokens.has(token);
}

const UNAUTHORIZED = Response.json(
  { errorCode: 'unauthorized', errorDescription: 'join required' },
  { status: 401 },
);

// Unique per process start. Sent to clients in `welcome`; when a client sees a
// different boot id after an automatic reconnect, it knows the server restarted
// or was redeployed and fully reloads — clearing stale ghost avatars (the old
// in-memory peer map is gone, so leftover userIds never get a player-left) and
// picking up the new client bundle.
const BOOT_ID = crypto.randomUUID();

const server = Bun.serve({
  port: Number(process.env.PORT ?? 3000),
  hostname: '0.0.0.0',

  async fetch(req, server) {
    const url = new URL(req.url);

    if (url.pathname === '/ws') {
      const userId = crypto.randomUUID();
      const upgraded = server.upgrade(req, {
        data: {
          userId,
          name: '',
          workspace: '',
          x: 0,
          y: 0,
          zoneId: null,
          outfit: {
            sex: 0,
            skin: 0,
            hair: 0,
            hairColor: 0,
            top: 0,
            topColor: 0,
            bottom: 0,
            bottomColor: 0,
            shoes: 0,
            hat: 0,
            glasses: 0,
          },
          sfuSessionId: null,
          sfuTracks: [],
          groupKey: null,
          mediaToken: null,
          lastGroupAt: 0,
          joined: false,
        } satisfies WsData,
      });
      if (upgraded) return undefined;
      return new Response('Upgrade failed', { status: 500 });
    }

    if (url.pathname === '/api/turn-credentials') {
      if (!hasValidMediaToken(req)) return UNAUTHORIZED;
      const iceServers = await getTurnCredentials();
      return Response.json(iceServers, {
        headers: { 'Cache-Control': 'no-store' },
      });
    }

    if (url.pathname === '/api/health') {
      return Response.json({ ok: true, clients: clients.size });
    }

    // Public pre-join config: whether the space requires a password. The client
    // uses this to decide whether to show the password gate before the name step.
    if (url.pathname === '/api/config') {
      return Response.json(
        { passwordRequired: isPasswordRequired(ACCESS_PASSWORD) },
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
        { ok: verifyAccessPassword(password, ACCESS_PASSWORD) },
        { headers: { 'Cache-Control': 'no-store' } },
      );
    }

    // SFU control-plane proxy: forwards to Cloudflare Realtime with the app id +
    // token attached server-side (the browser never sees them). Signaling only —
    // media never traverses our server. The path after /sessions is whitelisted
    // to the documented endpoints (SSRF / traversal guard, see sfu.ts).
    if (url.pathname.startsWith('/api/sfu/sessions')) {
      if (!hasValidMediaToken(req)) return UNAUTHORIZED;
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
    const file = Bun.file(`${PUBLIC_DIR}${reqPath}`);
    if (await file.exists()) {
      return new Response(file);
    }
    // SPA fallback to index.html (in case client uses any client-side routing)
    const indexFile = Bun.file(`${PUBLIC_DIR}/index.html`);
    if ((await indexFile.exists()) && !reqPath.includes('.')) {
      return new Response(indexFile);
    }
    return new Response('Not Found', { status: 404 });
  },

  websocket: createWebSocketHandler(clients, ACCESS_PASSWORD, BOOT_ID, mediaTokens),
});

console.log(`Server running on http://${server.hostname}:${server.port}`);
