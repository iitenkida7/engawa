import type { ServerWebSocket, WebSocketHandler } from 'bun';
import {
  clampPosition,
  computeProximityGroups,
  type GroupMember,
  generateSpawn,
  isAllowedReaction,
  isValidStreamMetaKind,
  MAP_HEIGHT,
  MAP_WIDTH,
  normalizeBool,
  normalizeChatText,
  normalizeName,
  normalizePlayerStatus,
  normalizeResumeToken,
  normalizeSfuTracks,
  normalizeStatusNote,
  normalizeStreamId,
  normalizeUntil,
  normalizeVelocity,
  normalizeWorkspace,
  PROXIMITY_DISCONNECT_RADIUS,
  type ProximityGroup,
  sanitizeOutfit,
  sfuLatchSeeds,
  verifyAccessPassword,
} from './logic';
import { isSfuEnabled } from './sfu';
import type { ClientMessage, Player, ServerMessage, WsData } from './types';

// Single optional access password from env. Empty/unset → the space is open and
// no password is ever requested.
const accessPasswordEnv = process.env.ACCESS_PASSWORD;

// Minimum gap (ms) between proximity-group recomputes triggered by one socket's
// `move` messages. The client sends moves at ~20Hz, so a legitimate mover always
// clears this; it only caps a single connection that floods moves at wire speed
// (the O(n²) recompute is the expensive part). Position updates and player-moved
// relays are never throttled, so movement stays fully responsive and the group
// hysteresis tolerates the ≤33ms lag.
const GROUP_RECOMPUTE_MIN_INTERVAL_MS = 33;

// How long after a joined socket closes its leave stays un-finalized (issue
// #187): within this window a reconnect presenting the connection's resume
// token adopts the same userId/position/group, so peers never see a leave and
// live calls survive a signaling blip. Client-side dead-socket detection (the
// 12s heartbeat pong timeout) plus one reconnect round-trip fits inside it.
export const RESUME_GRACE_MS = 15_000;

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

// The member ids of the proximity group this connection currently belongs to,
// read straight off the last group signature the server sent it
// (groupKey = "<method>:<id1>,<id2>,..."). broadcastGroups keeps groupKey in
// sync on every join / move / close, so it is the authoritative current group —
// crucially including the open-floor hysteresis (connect 120px, disconnect
// 150px) and the SFU latch that a fresh, option-less computeProximityGroups
// would drop, silently splitting a pair still held together in the same call.
// Always includes this user, so a solo speaker still sees their own chat echo.
function groupMemberIdsOf(ws: ServerWebSocket<WsData>): string[] {
  const key = ws.data.groupKey;
  if (!key) return [ws.data.userId];
  const sep = key.indexOf(':');
  return sep < 0 ? [ws.data.userId] : key.slice(sep + 1).split(',');
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
  accessPassword: string | undefined = accessPasswordEnv,
  // Unique per server process start. Sent in every `welcome`; the client reloads
  // when it sees a different id after reconnecting (see client reload.ts).
  bootId: string = 'dev',
  // Valid media tokens (see WsData.mediaToken). Shared with the HTTP layer
  // (index.ts) so /api/turn-credentials and /api/sfu/* can require one. Defaults
  // to a private set so unit tests need not pass it. Transient (invariant #2).
  mediaTokens: Set<string> = new Set(),
  // Injectable clock for the per-connection move throttle, so tests are
  // deterministic. Production uses Date.now.
  now: () => number = Date.now,
  // Leave-grace window (issue #187); injectable so tests don't wait 15s.
  leaveGraceMs: number = RESUME_GRACE_MS,
): WebSocketHandler<WsData> {
  // Per-workspace SFU latch state. Lives for the handler's lifetime (one server
  // process); reset on restart, never persisted (invariant #2).
  const groupState: GroupState = new Map();

  // Leaves awaiting finalization, keyed by resume token (issue #187). The
  // closed socket stays in `clients` (holding its position/group presence)
  // until the timer fires; a resume cancels the timer and adopts the identity.
  // Memory-only and self-cleaning — expired entries finalize themselves.
  const pendingLeave = new Map<string, { userId: string; timer: ReturnType<typeof setTimeout> }>();

  // The previous connection a resume token refers to: a socket waiting out its
  // leave grace, or — when the server never noticed the drop (half-open) — the
  // still-registered live socket carrying that token. Returns null for unknown
  // tokens, and never matches `exclude` (the socket trying to resume).
  function findResumable(
    token: string,
    exclude: ServerWebSocket<WsData>,
  ): ServerWebSocket<WsData> | null {
    const pending = pendingLeave.get(token);
    if (pending) {
      const ws = clients.get(pending.userId);
      if (ws && ws !== exclude && ws.data.resumeToken === token) return ws;
      return null;
    }
    for (const c of clients.values()) {
      if (c !== exclude && c.data.joined && c.data.resumeToken === token) return c;
    }
    return null;
  }

  // Finalize a leave: forget the connection, invalidate its media token, and
  // tell the workspace. Runs when the grace timer fires without a resume.
  function finalizeLeave(token: string, ws: ServerWebSocket<WsData>) {
    pendingLeave.delete(token);
    if (clients.get(ws.data.userId) !== ws) return; // resumed / replaced meanwhile
    if (ws.data.mediaToken) {
      mediaTokens.delete(ws.data.mediaToken);
      ws.data.mediaToken = null;
    }
    clients.delete(ws.data.userId);
    broadcast(clients, ws.data.workspace, { type: 'player-left', userId: ws.data.userId });
    broadcastGroups(clients, ws.data.workspace, groupState);
    console.log(`[ws] leave finalized ${ws.data.userId} (clients=${clients.size})`);
  }

  return {
    // Dead-peer detection (issue #183). Explicit rather than Bun's defaults so
    // ghost avatars from silently-dead clients are bounded: the client heartbeats
    // every 5s, so 30s of silence (protocol pings unanswered, no messages) means
    // the peer is gone and the close handler should run.
    idleTimeout: 30,
    sendPings: true,

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
      // JSON.parse succeeds for `null`, `123`, `"x"` etc.; the switch below would
      // then throw on property access. Require an object with a string `type`.
      if (typeof msg !== 'object' || msg === null || typeof msg.type !== 'string') return;

      switch (msg.type) {
        case 'ping': {
          // Heartbeat (issue #183). Answered pre-join too: the client's dead-
          // socket detection must work while the join handshake is in flight.
          send(ws, { type: 'pong' });
          break;
        }

        case 'join': {
          // One socket joins exactly once (the client sends join once per
          // connection; a reconnect uses a fresh socket). Without this guard a
          // non-standard client could re-join with a different workspace, leaving
          // ghost avatars in the old one and leaking per-workspace group state.
          if (ws.data.joined) return;

          const workspace = normalizeWorkspace(msg.workspace);
          // Single access-password gate (defense in depth — the client also checks
          // via /api/verify-password before showing the name step).
          if (!verifyAccessPassword(msg.password, accessPassword)) {
            send(ws, { type: 'auth-error', message: 'パスワードが正しくありません' });
            ws.close(4001, 'auth failed');
            return;
          }

          // Session resume (issue #187): a valid token identifying a connection
          // in its leave-grace window (or a half-open predecessor the server
          // hasn't noticed dying) adopts that identity — same userId, position,
          // group — so peers never see a leave/join and live calls survive.
          const resumeToken = normalizeResumeToken(msg.resumeToken);
          const prev = resumeToken ? findResumable(resumeToken, ws) : null;
          if (resumeToken && prev) {
            const pending = pendingLeave.get(resumeToken);
            if (pending) {
              clearTimeout(pending.timer);
              pendingLeave.delete(resumeToken);
            }
            // The predecessor's tokens die with it; a half-open one is closed
            // (its stale close is ignored by the identity check below).
            if (prev.data.mediaToken) {
              mediaTokens.delete(prev.data.mediaToken);
              prev.data.mediaToken = null;
            }
            prev.data.resumeToken = null;
            try {
              prev.close(4002, 'resumed by a new connection');
            } catch {
              /* already closed */
            }
            // Drop the fresh id minted at upgrade and adopt the previous one.
            clients.delete(ws.data.userId);
            ws.data.userId = prev.data.userId;
            ws.data.name = prev.data.name;
            ws.data.workspace = prev.data.workspace;
            ws.data.x = prev.data.x;
            ws.data.y = prev.data.y;
            ws.data.zoneId = prev.data.zoneId;
            ws.data.outfit = sanitizeOutfit(msg.outfit);
            ws.data.groupKey = prev.data.groupKey;
            ws.data.sfuSessionId = prev.data.sfuSessionId;
            ws.data.sfuTracks = prev.data.sfuTracks;
            ws.data.joined = true;
            clients.set(ws.data.userId, ws);

            const mediaToken = crypto.randomUUID();
            ws.data.mediaToken = mediaToken;
            mediaTokens.add(mediaToken);
            // Single-use: rotate the resume token on every welcome.
            ws.data.resumeToken = crypto.randomUUID();

            const others: Player[] = [];
            for (const [id, c] of clients) {
              if (id === ws.data.userId || !c.data.joined) continue;
              if (c.data.workspace !== ws.data.workspace) continue;
              others.push(playerFromWs(c));
            }
            send(ws, {
              type: 'welcome',
              self: playerFromWs(ws),
              players: others,
              bootId,
              sfuEnabled: isSfuEnabled(),
              token: mediaToken,
              resumeToken: ws.data.resumeToken,
              resumed: true,
            });
            // No player-joined broadcast — peers never saw us leave. Groups are
            // recomputed in case topology changed during the gap.
            broadcastGroups(clients, ws.data.workspace, groupState);
            console.log(`[ws] resumed ${ws.data.userId} as "${ws.data.name}"`);
            break;
          }

          ws.data.name = normalizeName(msg.name);
          ws.data.workspace = workspace;
          ws.data.outfit = sanitizeOutfit(msg.outfit);
          // Spawn in the open office area (center aisle, avoids walls/desks)
          const spawn = generateSpawn();
          ws.data.x = spawn.x;
          ws.data.y = spawn.y;
          ws.data.joined = true;
          // Mint the short-lived media token now that auth passed, register it as
          // valid, and hand it to the client in `welcome`. It gates the billable
          // Cloudflare HTTP endpoints to live joined sessions; dropped when the
          // leave finalizes. The resume token pairs with it (issue #187).
          const mediaToken = crypto.randomUUID();
          ws.data.mediaToken = mediaToken;
          mediaTokens.add(mediaToken);
          ws.data.resumeToken = crypto.randomUUID();

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
            token: mediaToken,
            resumeToken: ws.data.resumeToken,
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
          // Throttle only the expensive O(n²) group recompute per connection; the
          // position update and player-moved relay above always run so movement
          // stays responsive. The group hysteresis absorbs the ≤33ms lag.
          const t = now();
          if (t - ws.data.lastGroupAt >= GROUP_RECOMPUTE_MIN_INTERVAL_MS) {
            ws.data.lastGroupAt = t;
            broadcastGroups(clients, ws.data.workspace, groupState);
          }
          break;
        }

        case 'signal': {
          if (!ws.data.joined) return;
          const target = clients.get(msg.to);
          // Same-workspace guard (mirrors knock): signaling must not cross the
          // workspace isolation boundary to a userId learned elsewhere.
          if (!target?.data.joined || target.data.workspace !== ws.data.workspace) return;
          send(target, {
            type: 'signal',
            from: ws.data.userId,
            data: msg.data,
          });
          break;
        }

        case 'rtc-restart': {
          if (!ws.data.joined) return;
          // Same-workspace 1:1 relay, mirroring signal: a mesh-recovery nudge
          // must not cross the workspace boundary either (issue #184).
          const target = clients.get(msg.to);
          if (!target?.data.joined || target.data.workspace !== ws.data.workspace) return;
          send(target, { type: 'rtc-restart', from: ws.data.userId });
          break;
        }

        case 'stream-meta': {
          if (!ws.data.joined) return;
          const target = clients.get(msg.to);
          if (!target?.data.joined || target.data.workspace !== ws.data.workspace) return;
          // Validate the relayed fields (the server forwards them verbatim): an
          // unknown kind or an oversized/empty streamId is dropped rather than
          // propagated to the peer.
          if (!isValidStreamMetaKind(msg.kind)) return;
          const streamId = normalizeStreamId(msg.streamId);
          if (streamId === null) return;
          send(target, {
            type: 'stream-meta',
            from: ws.data.userId,
            streamId,
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
          const memberIds = groupMemberIdsOf(ws);
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
      // Identity check: a resume/reconnect may have already replaced this entry
      // in the map. A stale close must not evict the live connection — it only
      // cleans up its own media token (normally already invalidated on resume).
      const isCurrent = clients.get(ws.data.userId) === ws;
      if (!isCurrent) {
        if (ws.data.mediaToken) {
          mediaTokens.delete(ws.data.mediaToken);
          ws.data.mediaToken = null;
        }
        console.log(`[ws] close (stale) ${ws.data.userId} (clients=${clients.size})`);
        return;
      }
      // Leave grace (issue #187): a joined connection's presence — map entry,
      // position, group membership, media token — survives for leaveGraceMs so
      // a resume can adopt it without peers ever seeing a leave. The socket is
      // dead, so broadcasts to it silently no-op until then.
      if (ws.data.joined && ws.data.resumeToken) {
        const token = ws.data.resumeToken;
        const timer = setTimeout(() => finalizeLeave(token, ws), leaveGraceMs);
        pendingLeave.set(token, { userId: ws.data.userId, timer });
        console.log(`[ws] close ${ws.data.userId} (leave grace ${leaveGraceMs}ms)`);
        return;
      }
      // Never joined (or no resume token): clean up immediately, as before.
      if (ws.data.mediaToken) {
        mediaTokens.delete(ws.data.mediaToken);
        ws.data.mediaToken = null;
      }
      clients.delete(ws.data.userId);
      if (ws.data.joined) {
        broadcast(clients, ws.data.workspace, { type: 'player-left', userId: ws.data.userId });
        broadcastGroups(clients, ws.data.workspace, groupState);
      }
      console.log(`[ws] close ${ws.data.userId} (clients=${clients.size})`);
    },
  };
}

export { MAP_HEIGHT, MAP_WIDTH };
