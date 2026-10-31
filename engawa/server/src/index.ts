import type { ServerWebSocket } from 'bun';
import { createHttpHandler } from './http';
import { loadMap, mapWorld } from './map';
import { startSettingsSync } from './settings';
import type { WsData } from './types';
import { createWebSocketHandler } from './websocket';

const clients = new Map<string, ServerWebSocket<WsData>>();
const PUBLIC_DIR = './public';

// Settings a control plane supplies (CONTROL_PLANE_URL), fetched before
// anything reads them. Without one this is a no-op and the environment is the
// only source. See docs/control-plane.md.
await startSettingsSync();

// Valid short-lived media tokens, minted per connection on a successful join and
// removed on close (see websocket.ts). Requiring one on the Cloudflare-backed
// endpoints ties consumption of the billable TURN/SFU resources to a live joined
// session, so an anonymous HTTP client can't farm credentials or run sessions.
// Transient in-memory only — reset on restart (invariant #2).
const mediaTokens = new Set<string>();

// Unique per process start. Sent to clients in `welcome`; when a client sees a
// different boot id after an automatic reconnect, it knows the server restarted
// or was redeployed and fully reloads — clearing stale ghost avatars (the old
// in-memory peer map is gone, so leftover userIds never get a player-left) and
// picking up the new client bundle.
const BOOT_ID = crypto.randomUUID();

// The map (MAP: a bundled preset name or a URL), validated once at boot: a bad map stops the
// server here rather than breaking every browser that loads it.
const map = await loadMap(process.env.MAP).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
console.log(`[map] ${map.source} (${map.def.cols}x${map.def.rows} tiles)`);

// Every route but the websocket upgrade, which needs the server object below.
const handleHttp = createHttpHandler({
  clients,
  mediaTokens,
  mapJson: JSON.stringify(map.def),
  publicDir: PUBLIC_DIR,
});

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
          seated: false,
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
          avatarImage: null,
          sfuSessionId: null,
          sfuTracks: [],
          groupKey: null,
          mediaToken: null,
          resumeToken: null,
          clientId: null,
          lastGroupAt: 0,
          lastMoveAt: 0,
          occluded: [],
          joined: false,
          away: false,
        } satisfies WsData,
      });
      if (upgraded) return undefined;
      return new Response('Upgrade failed', { status: 500 });
    }

    return handleHttp(req);
  },

  // undefined = that parameter's default (clock, leave grace, event webhook).
  websocket: createWebSocketHandler(
    clients,
    // undefined = resolve the access password per join, so a control-plane
    // change takes effect without dropping everyone in the office.
    undefined,
    BOOT_ID,
    mediaTokens,
    undefined,
    undefined,
    undefined,
    mapWorld(map.def),
  ),
});

console.log(`Server running on http://${server.hostname}:${server.port}`);
