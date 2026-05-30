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
  computeProximityGroups,
  generateSpawn,
  normalizeName,
  normalizeWorkspace,
  parseWorkspacePasswords,
  sfuLatchSeeds,
  verifyWorkspacePassword,
  type GroupMember,
  type ProximityGroup,
} from './logic';
import { isSfuEnabled } from './sfu';

// Workspace passwords from env: JSON object like {"ws1":"pass1","ws2":"pass2"}
// If empty or not set, all workspaces are open (no auth required).
const workspacePasswords = parseWorkspacePasswords(process.env.WORKSPACE_PASSWORDS);

// Per-workspace transient grouping state: the previous tick's open-floor SFU
// member sets, so a shrinking cluster keeps SFU (one-way latch). Memory-only,
// reset on restart (stateless invariant #2).
type GroupState = Map<string, { prevSfuMemberSets: string[][] }>;

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

// Recompute one workspace's proximity groups and notify clients whose SFU
// membership changed. Returns userId → group so callers can look up a member's
// current group. Plain-mesh members are intentionally NOT messaged — they are
// driven by the client's legacy proximity loop; only SFU membership (and the
// SFU→mesh transition, so the client tears the transport down) is signaled,
// which keeps message volume minimal. When SFU is disabled every group is mesh,
// so no group-update is ever sent and behaviour is identical to pre-SFU.
function broadcastGroups(
  clients: Map<string, ServerWebSocket<WsData>>,
  workspace: string,
  groupState: GroupState,
): Map<string, ProximityGroup> {
  const members: GroupMember[] = [];
  const wsClients: ServerWebSocket<WsData>[] = [];
  for (const c of clients.values()) {
    if (!c.data.joined || c.data.workspace !== workspace) continue;
    members.push({ userId: c.data.userId, x: c.data.x, y: c.data.y, zoneId: c.data.zoneId });
    wsClients.push(c);
  }

  const state = groupState.get(workspace) ?? { prevSfuMemberSets: [] };
  const groups = computeProximityGroups(members, {
    sfuEnabled: isSfuEnabled(),
    prevSfuMemberSets: state.prevSfuMemberSets,
  });

  const byUser = new Map<string, ProximityGroup>();
  for (const g of groups) for (const id of g.memberIds) byUser.set(id, g);

  for (const c of wsClients) {
    const g = byUser.get(c.data.userId);
    if (!g) continue;
    if (g.method === 'sfu') {
      const key = `sfu:${g.memberIds.join(',')}`;
      if (c.data.groupKey === key) continue;
      c.data.groupKey = key;
      send(c, { type: 'group-update', method: 'sfu', members: g.memberIds });
      // Hand this client the current track directory of the group's other
      // already-published members so it can pull them. When a member (re)joins
      // the group every member's key changes, so the reverse direction — telling
      // existing members about the newcomer's tracks — is covered by their own
      // re-send here too.
      for (const other of wsClients) {
        if (other.data.userId === c.data.userId) continue;
        if (!g.memberIds.includes(other.data.userId)) continue;
        if (!other.data.sfuSessionId) continue;
        send(c, {
          type: 'sfu-peer-tracks',
          userId: other.data.userId,
          sessionId: other.data.sfuSessionId,
          tracks: other.data.sfuTracks,
        });
      }
    } else if (c.data.groupKey !== null) {
      // Was in an SFU group, now mesh: tell the client to drop the SFU transport
      // and fall back to the mesh proximity loop.
      c.data.groupKey = null;
      send(c, { type: 'group-update', method: 'mesh', members: g.memberIds });
    }
  }

  state.prevSfuMemberSets = sfuLatchSeeds(groups);
  groupState.set(workspace, state);
  return byUser;
}

export function createWebSocketHandler(
  clients: Map<string, ServerWebSocket<WsData>>,
  passwordTable: Map<string, string> = workspacePasswords,
  // Unique per server process start. Sent in every `welcome`; the client reloads
  // when it sees a different id after reconnecting (see client reload.ts).
  bootId: string = 'dev',
): WebSocketHandler<WsData> {
  // Per-workspace SFU latch state. Lives for the handler's lifetime (one server
  // process); reset on restart, never persisted (invariant #2).
  const groupState: GroupState = new Map();

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
            sfuEnabled: isSfuEnabled(),
          });

          broadcast(
            clients,
            ws.data.workspace,
            { type: 'player-joined', player: playerFromWs(ws) },
            ws.data.userId,
          );
          broadcastGroups(clients, ws.data.workspace, groupState);
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
          ws.data.zoneId = msg.zoneId ?? null;
          broadcast(
            clients,
            ws.data.workspace,
            { type: 'player-moved', userId: ws.data.userId, x, y, vx, vy },
            ws.data.userId,
          );
          broadcastGroups(clients, ws.data.workspace, groupState);
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

        case 'sfu-publish': {
          if (!ws.data.joined) return;
          // Reject a malformed session id (it is forwarded to Cloudflare via
          // peers' pulls). We can't fully prove ownership — sessions are created
          // over the HTTP proxy, which isn't tied to this socket — but the peer
          // userId in the relayed directory is set by us, so a client can only
          // ever mis-announce its OWN tracks, never impersonate another user.
          if (typeof msg.sessionId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(msg.sessionId)) return;
          // Record this client's published directory and relay it to the current
          // SFU group's members. A publish does not change membership, so we do
          // not recompute groups — the members are read straight off the last
          // group signature sent to this client (groupKey = "sfu:id1,id2,...").
          ws.data.sfuSessionId = msg.sessionId;
          ws.data.sfuTracks = msg.tracks;
          if (ws.data.groupKey?.startsWith('sfu:')) {
            const members = ws.data.groupKey.slice('sfu:'.length).split(',');
            for (const c of clients.values()) {
              if (c.data.userId === ws.data.userId) continue;
              if (!c.data.joined || c.data.workspace !== ws.data.workspace) continue;
              if (!members.includes(c.data.userId)) continue;
              send(c, {
                type: 'sfu-peer-tracks',
                userId: ws.data.userId,
                sessionId: msg.sessionId,
                tracks: msg.tracks,
              });
            }
          }
          break;
        }
      }
    },

    close(ws) {
      clients.delete(ws.data.userId);
      if (ws.data.joined) {
        broadcast(clients, ws.data.workspace, { type: 'player-left', userId: ws.data.userId });
        broadcastGroups(clients, ws.data.workspace, groupState);
      }
      console.log(`[ws] close ${ws.data.userId} (clients=${clients.size})`);
    },
  };
}

export { MAP_WIDTH, MAP_HEIGHT };
