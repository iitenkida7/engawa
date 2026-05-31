import type { ServerWebSocket } from 'bun';
import { isAllowedSessionPath, isSfuEnabled, proxySfuRequest } from './sfu';
import { getTurnCredentials } from './turn';
import type { WsData } from './types';
import { createWebSocketHandler } from './websocket';

const clients = new Map<string, ServerWebSocket<WsData>>();
const PUBLIC_DIR = './public';

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
          sfuSessionId: null,
          sfuTracks: [],
          groupKey: null,
          joined: false,
        } satisfies WsData,
      });
      if (upgraded) return undefined;
      return new Response('Upgrade failed', { status: 500 });
    }

    if (url.pathname === '/api/turn-credentials') {
      const iceServers = await getTurnCredentials();
      return Response.json(iceServers, {
        headers: { 'Cache-Control': 'no-store' },
      });
    }

    if (url.pathname === '/api/health') {
      return Response.json({ ok: true, clients: clients.size });
    }

    // SFU control-plane proxy: forwards to Cloudflare Realtime with the app id +
    // token attached server-side (the browser never sees them). Signaling only —
    // media never traverses our server. The path after /sessions is whitelisted
    // to the documented endpoints (SSRF / traversal guard, see sfu.ts).
    if (url.pathname.startsWith('/api/sfu/sessions')) {
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

  websocket: createWebSocketHandler(clients, undefined, BOOT_ID),
});

console.log(`Server running on http://${server.hostname}:${server.port}`);
