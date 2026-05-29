import type { ServerWebSocket, WebSocketHandler } from 'bun';
import type {
  ClientMessage,
  Player,
  ServerMessage,
  WsData,
} from './types';

const MAP_WIDTH = 2000;
const MAP_HEIGHT = 1500;

function send(ws: ServerWebSocket<WsData>, msg: ServerMessage) {
  ws.send(JSON.stringify(msg));
}

function broadcast(
  clients: Map<string, ServerWebSocket<WsData>>,
  workspace: string,
  msg: ServerMessage,
  exceptUserId?: string,
) {
  const str = JSON.stringify(msg);
  for (const [id, c] of clients) {
    if (id === exceptUserId) continue;
    if (!c.data.joined) continue;
    if (c.data.workspace !== workspace) continue;
    c.send(str);
  }
}

function playerFromWs(ws: ServerWebSocket<WsData>): Player {
  return {
    userId: ws.data.userId,
    name: ws.data.name,
    x: ws.data.x,
    y: ws.data.y,
  };
}

export function createWebSocketHandler(
  clients: Map<string, ServerWebSocket<WsData>>,
): WebSocketHandler<WsData> {
  return {
    open(ws) {
      clients.set(ws.data.userId, ws);
      console.log(`[ws] open ${ws.data.userId} (clients=${clients.size})`);
    },

    message(ws, raw) {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(typeof raw === 'string' ? raw : raw.toString());
      } catch {
        return;
      }

      switch (msg.type) {
        case 'join': {
          ws.data.name = (msg.name || 'anon').slice(0, 24);
          ws.data.workspace = (msg.workspace || 'default').slice(0, 64);
          // Spawn in the open office area (center aisle, avoids walls/desks)
          ws.data.x = 800 + Math.random() * 400;
          ws.data.y = 400 + Math.random() * 600;
          ws.data.joined = true;

          const existing: Player[] = [];
          for (const [id, c] of clients) {
            if (id === ws.data.userId) continue;
            if (!c.data.joined) continue;
            if (c.data.workspace !== ws.data.workspace) continue;
            existing.push(playerFromWs(c));
          }

          send(ws, {
            type: 'welcome',
            self: playerFromWs(ws),
            players: existing,
          });

          broadcast(
            clients,
            ws.data.workspace,
            { type: 'player-joined', player: playerFromWs(ws) },
            ws.data.userId,
          );
          console.log(`[ws] joined ${ws.data.userId} as "${ws.data.name}"`);
          break;
        }

        case 'move': {
          if (!ws.data.joined) return;
          const x = Math.max(0, Math.min(MAP_WIDTH, Number(msg.x) || 0));
          const y = Math.max(0, Math.min(MAP_HEIGHT, Number(msg.y) || 0));
          const vx = Number(msg.vx) || 0;
          const vy = Number(msg.vy) || 0;
          ws.data.x = x;
          ws.data.y = y;
          broadcast(
            clients,
            ws.data.workspace,
            { type: 'player-moved', userId: ws.data.userId, x, y, vx, vy },
            ws.data.userId,
          );
          break;
        }

        case 'signal': {
          if (!ws.data.joined) return;
          const target = clients.get(msg.to);
          if (!target || !target.data.joined) return;
          send(target, {
            type: 'signal',
            from: ws.data.userId,
            data: msg.data,
          });
          break;
        }

        case 'stream-meta': {
          if (!ws.data.joined) return;
          const target = clients.get(msg.to);
          if (!target || !target.data.joined) return;
          send(target, {
            type: 'stream-meta',
            from: ws.data.userId,
            streamId: msg.streamId,
            kind: msg.kind,
          });
          break;
        }
      }
    },

    close(ws) {
      clients.delete(ws.data.userId);
      if (ws.data.joined) {
        broadcast(clients, ws.data.workspace, { type: 'player-left', userId: ws.data.userId });
      }
      console.log(`[ws] close ${ws.data.userId} (clients=${clients.size})`);
    },
  };
}

export { MAP_WIDTH, MAP_HEIGHT };
