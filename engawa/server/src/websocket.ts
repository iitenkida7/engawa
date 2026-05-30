import type { ServerWebSocket, WebSocketHandler } from 'bun';
import type {
  ClientMessage,
  Player,
  ServerMessage,
  WsData,
} from './types';
import {
  MAP_HEIGHT,
  MAP_WIDTH,
  clampPosition,
  generateSpawn,
  normalizeName,
  normalizeWorkspace,
  parseWorkspacePasswords,
  verifyWorkspacePassword,
} from './logic';

// Workspace passwords from env: JSON object like {"ws1":"pass1","ws2":"pass2"}
// If empty or not set, all workspaces are open (no auth required).
const workspacePasswords = parseWorkspacePasswords(process.env.WORKSPACE_PASSWORDS);

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
  passwordTable: Map<string, string> = workspacePasswords,
  // Unique per server process start. Sent in every `welcome`; the client reloads
  // when it sees a different id after reconnecting (see client reload.ts).
  bootId: string = 'dev',
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
          const workspace = normalizeWorkspace(msg.workspace);
          if (!verifyWorkspacePassword(workspace, msg.password, passwordTable)) {
            send(ws, { type: 'auth-error', message: 'パスワードが正しくありません' });
            ws.close(4001, 'auth failed');
            return;
          }

          ws.data.name = normalizeName(msg.name);
          ws.data.workspace = workspace;
          // Spawn in the open office area (center aisle, avoids walls/desks)
          const spawn = generateSpawn();
          ws.data.x = spawn.x;
          ws.data.y = spawn.y;
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
            bootId,
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

        case 'status': {
          if (!ws.data.joined) return;
          broadcast(
            clients,
            ws.data.workspace,
            {
              type: 'player-status',
              userId: ws.data.userId,
              status: msg.status,
              isMuted: msg.isMuted,
              isVideoOn: msg.isVideoOn,
            },
            ws.data.userId,
          );
          break;
        }

        case 'move': {
          if (!ws.data.joined) return;
          const { x, y } = clampPosition(msg.x, msg.y, MAP_WIDTH, MAP_HEIGHT);
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
