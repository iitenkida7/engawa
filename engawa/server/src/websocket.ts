import type { ServerWebSocket, WebSocketHandler } from 'bun';
import {
  clampPosition,
  computeProximityGroups,
  type GroupMember,
  generateSpawn,
  isAllowedReaction,
  MAP_HEIGHT,
  MAP_WIDTH,
  normalizeBool,
  normalizeChatText,
  normalizeName,
  normalizePlayerStatus,
  normalizeSfuTracks,
  normalizeStatusNote,
  normalizeUntil,
  normalizeVelocity,
  normalizeWorkspace,
  PROXIMITY_DISCONNECT_RADIUS,
  type ProximityGroup,
  parseWorkspacePasswords,
  sanitizeOutfit,
  sfuLatchSeeds,
  verifyWorkspacePassword,
} from './logic';
import { isSfuEnabled } from './sfu';
import type { ClientMessage, Player, ServerMessage, WsData } from './types';

// Workspace passwords from env: JSON object like {"ws1":"pass1","ws2":"pass2"}
// If empty or not set, all workspaces are open (no auth required).
const workspacePasswords = parseWorkspacePasswords(process.env.WORKSPACE_PASSWORDS);

// Per-workspace transient grouping state, memory-only, reset on restart
// (stateless invariant #2):
//  - prevSfuMemberSets: the previous tick's open-floor SFU member sets, so a
//    shrinking cluster keeps SFU (one-way latch).
//  - prevGroupMemberSets: the previous tick's group memberships (all groups), so
//    an open-floor edge survives out to the disconnect radius (hysteresis).
type GroupState = Map<string, { prevSfuMemberSets: string[][]; prevGroupMemberSets: string[][] }>;

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
    outfit: ws.data.outfit,
  };
}

// The member ids of the proximity group `userId` currently belongs to — the
// same connected component the call uses (meeting-room isolation included).
// Reuses computeProximityGroups; membership is independent of the SFU/mesh
// method, so sfuEnabled is irrelevant here. Always includes `userId` itself, so
// a chat from someone standing alone still echoes back to them.
function proximityGroupMemberIds(
  clients: Map<string, ServerWebSocket<WsData>>,
  workspace: string,
  userId: string,
): string[] {
  const members: GroupMember[] = [];
  for (const c of clients.values()) {
    if (!c.data.joined || c.data.workspace !== workspace) continue;
    members.push({ userId: c.data.userId, x: c.data.x, y: c.data.y, zoneId: c.data.zoneId });
  }
  const groups = computeProximityGroups(members, { sfuEnabled: false });
  const g = groups.find((grp) => grp.memberIds.includes(userId));
  return g ? g.memberIds : [userId];
}

// Recompute one workspace's proximity groups and notify every client whose
// group membership changed. Returns userId → group so callers can look up a
// member's current group. Both mesh and SFU groups are signaled via
// `group-update`: the server is the single source of truth for who is in a
// call, so a mesh client connects to every member of its connected component
// (not just peers inside its own radius). This is what makes a latecomer who
// joins the edge of an existing cluster reach everyone, exactly like a meeting
// room. A message is only sent when a client's (method + member set) actually
// changes, so volume stays bounded by real topology changes.
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

  const state = groupState.get(workspace) ?? { prevSfuMemberSets: [], prevGroupMemberSets: [] };
  const groups = computeProximityGroups(members, {
    sfuEnabled: isSfuEnabled(),
    prevSfuMemberSets: state.prevSfuMemberSets,
    prevGroupMemberSets: state.prevGroupMemberSets,
    disconnectRadius: PROXIMITY_DISCONNECT_RADIUS,
  });

  const byUser = new Map<string, ProximityGroup>();
  for (const g of groups) for (const id of g.memberIds) byUser.set(id, g);

  for (const c of wsClients) {
    const g = byUser.get(c.data.userId);
    if (!g) continue;
    // Signature of the group as last sent to this client. A mesh→sfu (or the
    // reverse), or any change in the member set, flips this and re-notifies.
    const key = `${g.method}:${g.memberIds.join(',')}`;
    if (c.data.groupKey === key) continue;
    c.data.groupKey = key;
    send(c, { type: 'group-update', method: g.method, members: g.memberIds });
    if (g.method === 'sfu') {
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
    }
  }

  // Drop the transient state for a workspace once everyone has left, so
  // creating and abandoning many workspaces does not grow `groupState`
  // unbounded (invariant #2: signaling server holds no lasting state).
  if (wsClients.length === 0) {
    groupState.delete(workspace);
    return byUser;
  }

  state.prevSfuMemberSets = sfuLatchSeeds(groups);
  state.prevGroupMemberSets = groups.map((g) => g.memberIds);
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
          ws.data.outfit = sanitizeOutfit(msg.outfit);
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
              status: normalizePlayerStatus(msg.status),
              isMuted: normalizeBool(msg.isMuted),
              isVideoOn: normalizeBool(msg.isVideoOn),
              note: normalizeStatusNote(msg.note),
              until: normalizeUntil(msg.until),
            },
            ws.data.userId,
          );
          break;
        }

        case 'outfit-update': {
          if (!ws.data.joined) return;
          // Sanitize then relay to the workspace (peers re-render; the sender
          // updated its own avatar locally). Server keeps it only in transient
          // ws.data so a reconnecting peer's join re-announces it (invariant #2).
          const outfit = sanitizeOutfit(msg.outfit);
          ws.data.outfit = outfit;
          broadcast(
            clients,
            ws.data.workspace,
            { type: 'outfit-update', userId: ws.data.userId, outfit },
            ws.data.userId,
          );
          break;
        }

        case 'move': {
          if (!ws.data.joined) return;
          const { x, y } = clampPosition(msg.x, msg.y, MAP_WIDTH, MAP_HEIGHT);
          const vx = normalizeVelocity(msg.vx);
          const vy = normalizeVelocity(msg.vy);
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
          if (!target?.data.joined) return;
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
          if (!target?.data.joined) return;
          send(target, {
            type: 'stream-meta',
            from: ws.data.userId,
            streamId: msg.streamId,
            kind: msg.kind,
          });
          break;
        }

        case 'chat': {
          if (!ws.data.joined) return;
          const text = normalizeChatText(msg.text);
          if (!text) return;
          // Scope to the sender's proximity group so chat stays spatial; the
          // group always includes the sender, so they see their own line too.
          const memberIds = proximityGroupMemberIds(clients, ws.data.workspace, ws.data.userId);
          const out: ServerMessage = {
            type: 'chat',
            from: ws.data.userId,
            name: ws.data.name,
            text,
            ts: Date.now(),
          };
          for (const id of memberIds) {
            const c = clients.get(id);
            if (c?.data.joined) send(c, out);
          }
          break;
        }

        case 'reaction': {
          if (!ws.data.joined) return;
          // Whitelist-validate so a client can't broadcast arbitrary text. The
          // reaction goes to the whole workspace including the sender, so their
          // own avatar shows the bubble too (no separate local echo needed).
          if (!isAllowedReaction(msg.emoji)) return;
          broadcast(clients, ws.data.workspace, {
            type: 'reaction',
            userId: ws.data.userId,
            emoji: msg.emoji,
          });
          break;
        }

        case 'knock': {
          if (!ws.data.joined) return;
          const target = clients.get(msg.to);
          if (!target?.data.joined || target.data.workspace !== ws.data.workspace) return;
          send(target, { type: 'knock', from: ws.data.userId, name: ws.data.name });
          break;
        }

        case 'knock-reply': {
          if (!ws.data.joined) return;
          const target = clients.get(msg.to);
          if (!target?.data.joined || target.data.workspace !== ws.data.workspace) return;
          send(target, {
            type: 'knock-reply',
            from: ws.data.userId,
            name: ws.data.name,
            accept: !!msg.accept,
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
          // Validate the announced track directory (drop malformed/oversized
          // entries) before recording or relaying it — the server forwards it
          // verbatim to group peers.
          const tracks = normalizeSfuTracks(msg.tracks);
          // Record this client's published directory and relay it to the current
          // SFU group's members. A publish does not change membership, so we do
          // not recompute groups — the members are read straight off the last
          // group signature sent to this client (groupKey = "sfu:id1,id2,...").
          ws.data.sfuSessionId = msg.sessionId;
          ws.data.sfuTracks = tracks;
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
                tracks,
              });
            }
          }
          break;
        }
      }
    },

    close(ws) {
      // Identity check: a reconnect with the same userId may have already
      // replaced this entry in the map. Only remove (and announce the leave)
      // when the stored socket is *this* one, so a stale close does not evict
      // the live connection.
      const isCurrent = clients.get(ws.data.userId) === ws;
      if (isCurrent) {
        clients.delete(ws.data.userId);
        if (ws.data.joined) {
          broadcast(clients, ws.data.workspace, { type: 'player-left', userId: ws.data.userId });
          broadcastGroups(clients, ws.data.workspace, groupState);
        }
      }
      console.log(`[ws] close ${ws.data.userId} (clients=${clients.size})`);
    },
  };
}

export { MAP_HEIGHT, MAP_WIDTH };
