import type { ServerWebSocket } from 'bun';
import { createWebSocketHandler } from './websocket';
import { getTurnCredentials } from './turn';
import type { WsData } from './types';

const clients = new Map<string, ServerWebSocket<WsData>>();
const PUBLIC_DIR = './public';

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

    const reqPath = url.pathname === '/' ? '/index.html' : url.pathname;
    const file = Bun.file(`${PUBLIC_DIR}${reqPath}`);
    if (await file.exists()) {
      return new Response(file);
    }
    // SPA fallback to index.html (in case client uses any client-side routing)
    const indexFile = Bun.file(`${PUBLIC_DIR}/index.html`);
    if (await indexFile.exists() && !reqPath.includes('.')) {
      return new Response(indexFile);
    }
    return new Response('Not Found', { status: 404 });
  },

  websocket: createWebSocketHandler(clients),
});

console.log(`Server running on http://${server.hostname}:${server.port}`);
