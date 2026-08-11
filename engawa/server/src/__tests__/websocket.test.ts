import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { ServerWebSocket } from 'bun';
import type { Outfit, ServerMessage, WsData } from '../types';
import { createWebSocketHandler } from '../websocket';

// Minimal fake of ServerWebSocket<WsData> that records everything the handler
// sends and any close() call. Only the surface the handler actually touches is
// implemented; the rest is cast away.
type FakeWs = ServerWebSocket<WsData> & {
  sent: ServerMessage[];
  closed: { code?: number; reason?: string } | null;
};

// Build a full Outfit from partial fields (the rest default to 0). Lets tests
// pass only the indices they care about, and feed junk for sanitize checks.
const O = (o: Partial<Record<keyof Outfit, unknown>> = {}): Outfit => ({
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
  ...(o as Partial<Outfit>),
});

let nextId = 0;

function makeWs(data: Partial<WsData> = {}): FakeWs {
  const sent: ServerMessage[] = [];
  let closed: { code?: number; reason?: string } | null = null;
  const ws = {
    data: {
      userId: data.userId ?? `user-${nextId++}`,
      name: data.name ?? '',
      workspace: data.workspace ?? '',
      x: data.x ?? 0,
      y: data.y ?? 0,
      zoneId: data.zoneId ?? null,
      outfit: data.outfit ?? O(),
      sfuSessionId: data.sfuSessionId ?? null,
      sfuTracks: data.sfuTracks ?? [],
      groupKey: data.groupKey ?? null,
      mediaToken: data.mediaToken ?? null,
      resumeToken: data.resumeToken ?? null,
      lastGroupAt: data.lastGroupAt ?? 0,
      joined: data.joined ?? false,
    } satisfies WsData,
    send(payload: string | Bun.BufferSource) {
      sent.push(JSON.parse(payload as string) as ServerMessage);
      return 0;
    },
    close(code?: number, reason?: string) {
      closed = { code, reason };
    },
    get sent() {
      return sent;
    },
    get closed() {
      return closed;
    },
  };
  return ws as unknown as FakeWs;
}

/** Deliver a JSON-encoded client message to the handler. */
function deliver(handler: ReturnType<typeof createWebSocketHandler>, ws: FakeWs, msg: unknown) {
  handler.message!(ws, JSON.stringify(msg));
}

describe('createWebSocketHandler — open/close lifecycle', () => {
  let clients: Map<string, ServerWebSocket<WsData>>;
  let handler: ReturnType<typeof createWebSocketHandler>;

  beforeEach(() => {
    clients = new Map();
    handler = createWebSocketHandler(clients);
  });

  test('open registers the client in the map', () => {
    const ws = makeWs();
    handler.open!(ws);
    expect(clients.has(ws.data.userId)).toBe(true);
    expect(clients.size).toBe(1);
  });

  test('close removes the client and broadcasts player-left to joined peers', () => {
    const a = makeWs({ workspace: 'ws1', joined: true });
    const b = makeWs({ workspace: 'ws1', joined: true });
    handler.open!(a);
    handler.open!(b);

    handler.close!(a, 1000, '');

    expect(clients.has(a.data.userId)).toBe(false);
    expect(b.sent).toContainEqual({ type: 'player-left', userId: a.data.userId });
  });

  test('close does not broadcast a leave for a client that never joined', () => {
    const a = makeWs({ workspace: '', joined: false });
    const b = makeWs({ workspace: 'ws1', joined: true });
    handler.open!(a);
    handler.open!(b);

    handler.close!(a, 1000, '');

    expect(b.sent).toHaveLength(0);
  });

  test('a stale close for a re-used userId does not evict the live connection', () => {
    // Two sockets sharing the same userId (a reconnect that replaced the map
    // entry). When the stale first socket closes, the map must still hold the
    // newer one, and no spurious player-left should go out.
    const sharedId = 'dup-user';
    const stale = makeWs({ userId: sharedId, workspace: 'ws1', joined: true });
    const live = makeWs({ userId: sharedId, workspace: 'ws1', joined: true });
    const peer = makeWs({ workspace: 'ws1', joined: true });
    handler.open!(stale);
    handler.open!(live); // overwrites clients[sharedId] with the live socket
    handler.open!(peer);

    handler.close!(stale, 1000, '');

    // The live socket survives in the map.
    expect(clients.get(sharedId)).toBe(live);
    expect(clients.has(sharedId)).toBe(true);
    // No leave is announced, because the user is still connected.
    expect(peer.sent.some((m) => m.type === 'player-left')).toBe(false);
  });

  test('the live connection close still evicts and announces the leave', () => {
    const sharedId = 'dup-user-2';
    const stale = makeWs({ userId: sharedId, workspace: 'ws1', joined: true });
    const live = makeWs({ userId: sharedId, workspace: 'ws1', joined: true });
    const peer = makeWs({ workspace: 'ws1', joined: true });
    handler.open!(stale);
    handler.open!(live);
    handler.open!(peer);

    handler.close!(stale, 1000, ''); // stale: no-op on the map
    handler.close!(live, 1000, ''); // live: real removal

    expect(clients.has(sharedId)).toBe(false);
    expect(peer.sent).toContainEqual({ type: 'player-left', userId: sharedId });
  });
});

describe('createWebSocketHandler — join', () => {
  let clients: Map<string, ServerWebSocket<WsData>>;

  beforeEach(() => {
    clients = new Map();
  });

  test('welcomes the joiner with the existing player list in the same workspace', () => {
    const handler = createWebSocketHandler(clients);
    const existing = makeWs({ workspace: 'ws1', joined: true, name: 'Bob', x: 10, y: 20 });
    handler.open!(existing);

    const joiner = makeWs();
    handler.open!(joiner);
    deliver(handler, joiner, { type: 'join', name: 'Alice', workspace: 'ws1' });

    const welcome = joiner.sent.find((m) => m.type === 'welcome');
    expect(welcome).toBeDefined();
    if (welcome?.type !== 'welcome') throw new Error('expected welcome');
    expect(welcome.self.name).toBe('Alice');
    expect(welcome.players).toHaveLength(1);
    expect(welcome.players[0]).toMatchObject({
      userId: existing.data.userId,
      name: 'Bob',
      x: 10,
      y: 20,
    });
  });

  test('stamps the welcome with the server boot id', () => {
    const handler = createWebSocketHandler(clients, undefined, 'boot-xyz');
    const joiner = makeWs();
    handler.open!(joiner);
    deliver(handler, joiner, { type: 'join', name: 'Alice', workspace: 'ws1' });

    const welcome = joiner.sent.find((m) => m.type === 'welcome');
    if (welcome?.type !== 'welcome') throw new Error('expected welcome');
    expect(welcome.bootId).toBe('boot-xyz');
  });

  test('excludes peers from other workspaces and unjoined peers from the welcome list', () => {
    const handler = createWebSocketHandler(clients);
    const otherWs = makeWs({ workspace: 'ws2', joined: true, name: 'Other' });
    const unjoined = makeWs({ workspace: 'ws1', joined: false, name: 'Pending' });
    handler.open!(otherWs);
    handler.open!(unjoined);

    const joiner = makeWs();
    handler.open!(joiner);
    deliver(handler, joiner, { type: 'join', name: 'Alice', workspace: 'ws1' });

    const welcome = joiner.sent.find((m) => m.type === 'welcome');
    if (welcome?.type !== 'welcome') throw new Error('expected welcome');
    expect(welcome.players).toHaveLength(0);
  });

  test('broadcasts player-joined to existing peers but not back to the joiner', () => {
    const handler = createWebSocketHandler(clients);
    const peer = makeWs({ workspace: 'ws1', joined: true });
    handler.open!(peer);

    const joiner = makeWs();
    handler.open!(joiner);
    deliver(handler, joiner, { type: 'join', name: 'Alice', workspace: 'ws1' });

    const joinedMsg = peer.sent.find((m) => m.type === 'player-joined');
    expect(joinedMsg).toBeDefined();
    if (joinedMsg?.type !== 'player-joined') throw new Error('expected player-joined');
    expect(joinedMsg.player.name).toBe('Alice');

    // The joiner must not receive its own player-joined broadcast.
    expect(joiner.sent.some((m) => m.type === 'player-joined')).toBe(false);
  });

  test('rejects a join with a wrong password and closes the socket', () => {
    const handler = createWebSocketHandler(clients, 'secret');
    const joiner = makeWs();
    handler.open!(joiner);
    deliver(handler, joiner, { type: 'join', name: 'Alice', password: 'wrong' });

    expect(joiner.sent).toContainEqual({
      type: 'auth-error',
      message: 'パスワードが正しくありません',
    });
    expect(joiner.closed).toEqual({ code: 4001, reason: 'auth failed' });
    expect(joiner.data.joined).toBe(false);
  });

  test('accepts a join with the correct password', () => {
    const handler = createWebSocketHandler(clients, 'secret');
    const joiner = makeWs();
    handler.open!(joiner);
    deliver(handler, joiner, { type: 'join', name: 'Alice', password: 'secret' });

    expect(joiner.data.joined).toBe(true);
    expect(joiner.sent.some((m) => m.type === 'welcome')).toBe(true);
    expect(joiner.closed).toBeNull();
  });

  test('places the joiner inside the spawn area', () => {
    const handler = createWebSocketHandler(clients);
    const joiner = makeWs();
    handler.open!(joiner);
    deliver(handler, joiner, { type: 'join', name: 'Alice', workspace: 'ws1' });

    expect(joiner.data.x).toBeGreaterThanOrEqual(800);
    expect(joiner.data.x).toBeLessThan(1200);
    expect(joiner.data.y).toBeGreaterThanOrEqual(400);
    expect(joiner.data.y).toBeLessThan(1000);
  });

  test('ignores a second join on the same socket (no workspace switch)', () => {
    const handler = createWebSocketHandler(clients);
    const joiner = makeWs();
    handler.open!(joiner);
    deliver(handler, joiner, { type: 'join', name: 'Alice', workspace: 'ws1' });
    expect(joiner.data.workspace).toBe('ws1');

    // A second join (e.g. a non-standard client trying to switch workspaces) is
    // ignored: the connection stays in its original workspace and no second
    // welcome is emitted.
    deliver(handler, joiner, { type: 'join', name: 'Mallory', workspace: 'ws2' });
    expect(joiner.data.workspace).toBe('ws1');
    expect(joiner.data.name).toBe('Alice');
    expect(joiner.sent.filter((m) => m.type === 'welcome')).toHaveLength(1);
  });

  test('coerces non-string join name/workspace instead of throwing', () => {
    const handler = createWebSocketHandler(clients);
    const joiner = makeWs();
    handler.open!(joiner);
    // Numeric name and object workspace on the wire must not crash the handler.
    expect(() =>
      deliver(handler, joiner, { type: 'join', name: 123, workspace: {} }),
    ).not.toThrow();
    expect(joiner.data.joined).toBe(true);
    expect(joiner.data.name).toBe('anon');
    expect(joiner.data.workspace).toBe('default');
  });

  test('welcome carries a media token; it survives the leave grace and dies at finalize', async () => {
    const tokens = new Set<string>();
    // Tiny grace window so the test can await the finalization (issue #187).
    const handler = createWebSocketHandler(clients, undefined, 'dev', tokens, Date.now, 10);
    const joiner = makeWs();
    handler.open!(joiner);
    deliver(handler, joiner, { type: 'join', name: 'Alice', workspace: 'ws1' });

    const welcome = joiner.sent.find((m) => m.type === 'welcome');
    if (welcome?.type !== 'welcome') throw new Error('expected welcome');
    expect(typeof welcome.token).toBe('string');
    expect(welcome.token.length).toBeGreaterThan(0);
    expect(tokens.has(welcome.token)).toBe(true);

    handler.close!(joiner, 1000, '');
    // Still valid inside the grace window — a resuming client may be mid-flight
    // with TURN/SFU requests carrying it.
    expect(tokens.has(welcome.token)).toBe(true);
    await new Promise((r) => setTimeout(r, 30));
    expect(tokens.has(welcome.token)).toBe(false);
  });
});

describe('createWebSocketHandler — move', () => {
  let clients: Map<string, ServerWebSocket<WsData>>;
  let handler: ReturnType<typeof createWebSocketHandler>;

  beforeEach(() => {
    clients = new Map();
    handler = createWebSocketHandler(clients);
  });

  test('clamps out-of-range coordinates and broadcasts to peers', () => {
    const mover = makeWs({ workspace: 'ws1', joined: true });
    const peer = makeWs({ workspace: 'ws1', joined: true });
    handler.open!(mover);
    handler.open!(peer);

    deliver(handler, mover, { type: 'move', x: 99999, y: -100, vx: 1, vy: -2 });

    const moved = peer.sent.find((m) => m.type === 'player-moved');
    if (moved?.type !== 'player-moved') throw new Error('expected player-moved');
    expect(moved).toMatchObject({
      userId: mover.data.userId,
      x: 1700,
      y: 0,
      vx: 1,
      vy: -2,
    });
    // Server-side state is updated to the clamped value.
    expect(mover.data.x).toBe(1700);
    expect(mover.data.y).toBe(0);
  });

  test('normalizes a non-finite / oversized velocity before broadcasting (#125)', () => {
    const mover = makeWs({ workspace: 'ws1', joined: true });
    const peer = makeWs({ workspace: 'ws1', joined: true });
    handler.open!(mover);
    handler.open!(peer);

    deliver(handler, mover, { type: 'move', x: 100, y: 100, vx: Infinity, vy: 1e9 });

    const moved = peer.sent.find((m) => m.type === 'player-moved');
    if (moved?.type !== 'player-moved') throw new Error('expected player-moved');
    // Infinity collapses to 0; a huge finite value clamps to the velocity cap.
    expect(moved.vx).toBe(0);
    expect(moved.vy).toBe(2000);
  });

  test('does not echo the move back to the mover', () => {
    const mover = makeWs({ workspace: 'ws1', joined: true });
    handler.open!(mover);
    deliver(handler, mover, { type: 'move', x: 100, y: 100, vx: 0, vy: 0 });
    expect(mover.sent.some((m) => m.type === 'player-moved')).toBe(false);
  });

  test('ignores moves from a client that has not joined', () => {
    const mover = makeWs({ workspace: 'ws1', joined: false });
    const peer = makeWs({ workspace: 'ws1', joined: true });
    handler.open!(mover);
    handler.open!(peer);
    deliver(handler, mover, { type: 'move', x: 100, y: 100, vx: 0, vy: 0 });
    expect(peer.sent).toHaveLength(0);
  });
});

describe('createWebSocketHandler — outfit-update', () => {
  let clients: Map<string, ServerWebSocket<WsData>>;
  let handler: ReturnType<typeof createWebSocketHandler>;

  beforeEach(() => {
    clients = new Map();
    handler = createWebSocketHandler(clients);
  });

  test('relays a sanitized outfit to same-workspace peers and updates ws.data', () => {
    const sender = makeWs({ workspace: 'ws1', joined: true });
    const peer = makeWs({ workspace: 'ws1', joined: true });
    handler.open!(sender);
    handler.open!(peer);

    deliver(handler, sender, {
      type: 'outfit-update',
      outfit: O({ skin: 2, hair: 1, top: 3 }),
    });

    expect(peer.sent).toContainEqual({
      type: 'outfit-update',
      userId: sender.data.userId,
      outfit: O({ skin: 2, hair: 1, top: 3 }),
    });
    // The server keeps the (transient) outfit so a later join/welcome carries it.
    expect(sender.data.outfit).toEqual(O({ skin: 2, hair: 1, top: 3 }));
  });

  test('sanitizes oversized / garbage indices before relaying', () => {
    const sender = makeWs({ workspace: 'ws1', joined: true });
    const peer = makeWs({ workspace: 'ws1', joined: true });
    handler.open!(sender);
    handler.open!(peer);

    deliver(handler, sender, {
      type: 'outfit-update',
      outfit: O({ skin: 9999, hair: -3, top: 2.9, bottom: 'x' }),
    });

    const update = peer.sent.find((m) => m.type === 'outfit-update');
    if (update?.type !== 'outfit-update') throw new Error('expected outfit-update');
    // 9999 clamps to OUTFIT_MAX_INDEX (255); negatives / fractions / junk → 0 / trunc.
    expect(update.outfit).toEqual(O({ skin: 255, top: 2 }));
  });

  test('does not echo the outfit-update back to the sender', () => {
    const sender = makeWs({ workspace: 'ws1', joined: true });
    handler.open!(sender);
    deliver(handler, sender, {
      type: 'outfit-update',
      outfit: O({ skin: 1 }),
    });
    expect(sender.sent.some((m) => m.type === 'outfit-update')).toBe(false);
  });

  test('does not relay to peers in another workspace', () => {
    const sender = makeWs({ workspace: 'ws1', joined: true });
    const other = makeWs({ workspace: 'ws2', joined: true });
    handler.open!(sender);
    handler.open!(other);
    deliver(handler, sender, {
      type: 'outfit-update',
      outfit: O({ skin: 1 }),
    });
    expect(other.sent.some((m) => m.type === 'outfit-update')).toBe(false);
  });

  test('ignores an outfit-update from a client that has not joined', () => {
    const sender = makeWs({ workspace: 'ws1', joined: false });
    const peer = makeWs({ workspace: 'ws1', joined: true });
    handler.open!(sender);
    handler.open!(peer);
    deliver(handler, sender, {
      type: 'outfit-update',
      outfit: O({ skin: 1 }),
    });
    expect(peer.sent).toHaveLength(0);
    // ws.data is untouched (stays the default) when the message is ignored.
    expect(sender.data.outfit).toEqual(O());
  });

  test('a sanitized join outfit rides the player-joined broadcast to peers', () => {
    const peer = makeWs({ workspace: 'ws1', joined: true });
    handler.open!(peer);

    const joiner = makeWs();
    handler.open!(joiner);
    deliver(handler, joiner, {
      type: 'join',
      name: 'Alice',
      workspace: 'ws1',
      outfit: O({ skin: 4, hair: 2, top: 1, bottom: 2 }),
    });

    const joinedMsg = peer.sent.find((m) => m.type === 'player-joined');
    if (joinedMsg?.type !== 'player-joined') throw new Error('expected player-joined');
    expect(joinedMsg.player.outfit).toEqual(O({ skin: 4, hair: 2, top: 1, bottom: 2 }));
  });
});

describe('createWebSocketHandler — signal (targeted relay)', () => {
  let clients: Map<string, ServerWebSocket<WsData>>;
  let handler: ReturnType<typeof createWebSocketHandler>;

  beforeEach(() => {
    clients = new Map();
    handler = createWebSocketHandler(clients);
  });

  test('relays a signal only to the named target', () => {
    const sender = makeWs({ workspace: 'ws1', joined: true });
    const target = makeWs({ workspace: 'ws1', joined: true });
    const bystander = makeWs({ workspace: 'ws1', joined: true });
    handler.open!(sender);
    handler.open!(target);
    handler.open!(bystander);

    deliver(handler, sender, { type: 'signal', to: target.data.userId, data: { sdp: 'x' } });

    expect(target.sent).toContainEqual({
      type: 'signal',
      from: sender.data.userId,
      data: { sdp: 'x' },
    });
    expect(bystander.sent).toHaveLength(0);
  });

  test('drops a signal whose target is unknown', () => {
    const sender = makeWs({ workspace: 'ws1', joined: true });
    handler.open!(sender);
    deliver(handler, sender, { type: 'signal', to: 'ghost', data: {} });
    expect(sender.sent).toHaveLength(0);
  });

  test('drops a signal whose target has not joined', () => {
    const sender = makeWs({ workspace: 'ws1', joined: true });
    const target = makeWs({ workspace: 'ws1', joined: false });
    handler.open!(sender);
    handler.open!(target);
    deliver(handler, sender, { type: 'signal', to: target.data.userId, data: {} });
    expect(target.sent).toHaveLength(0);
  });

  test('drops a signal to a target in a different workspace', () => {
    const sender = makeWs({ workspace: 'ws1', joined: true });
    const target = makeWs({ workspace: 'ws2', joined: true });
    handler.open!(sender);
    handler.open!(target);
    deliver(handler, sender, { type: 'signal', to: target.data.userId, data: { sdp: 'x' } });
    expect(target.sent).toHaveLength(0);
  });
});

describe('createWebSocketHandler — status & stream-meta', () => {
  let clients: Map<string, ServerWebSocket<WsData>>;
  let handler: ReturnType<typeof createWebSocketHandler>;

  beforeEach(() => {
    clients = new Map();
    handler = createWebSocketHandler(clients);
  });

  test('broadcasts player-status to peers in the same workspace', () => {
    const sender = makeWs({ workspace: 'ws1', joined: true });
    const peer = makeWs({ workspace: 'ws1', joined: true });
    handler.open!(sender);
    handler.open!(peer);

    deliver(handler, sender, { type: 'status', status: 'busy', isMuted: true, isVideoOn: false });

    expect(peer.sent).toContainEqual({
      type: 'player-status',
      userId: sender.data.userId,
      status: 'busy',
      isMuted: true,
      isVideoOn: false,
      note: '',
      until: null,
    });
  });

  test('validates an unknown status and coerces flags before broadcasting (#125)', () => {
    const sender = makeWs({ workspace: 'ws1', joined: true });
    const peer = makeWs({ workspace: 'ws1', joined: true });
    handler.open!(sender);
    handler.open!(peer);

    // Bogus enum value and non-boolean flags arriving over the wire.
    deliver(handler, sender, {
      type: 'status',
      status: 'offline',
      isMuted: 'yes',
      isVideoOn: 1,
    });

    const status = peer.sent.find((m) => m.type === 'player-status');
    if (status?.type !== 'player-status') throw new Error('expected player-status');
    expect(status.status).toBe('online');
    expect(status.isMuted).toBe(false);
    expect(status.isVideoOn).toBe(false);
  });

  test('relays the status one-liner and return time, normalized (#85)', () => {
    const sender = makeWs({ workspace: 'ws1', joined: true });
    const peer = makeWs({ workspace: 'ws1', joined: true });
    handler.open!(sender);
    handler.open!(peer);

    deliver(handler, sender, {
      type: 'status',
      status: 'break',
      isMuted: false,
      isVideoOn: false,
      note: '  ランチ  ',
      until: 1893456000000,
    });

    expect(peer.sent).toContainEqual({
      type: 'player-status',
      userId: sender.data.userId,
      status: 'break',
      isMuted: false,
      isVideoOn: false,
      note: 'ランチ',
      until: 1893456000000,
    });
  });

  test('relays stream-meta only to the named target', () => {
    const sender = makeWs({ workspace: 'ws1', joined: true });
    const target = makeWs({ workspace: 'ws1', joined: true });
    handler.open!(sender);
    handler.open!(target);

    deliver(handler, sender, {
      type: 'stream-meta',
      to: target.data.userId,
      streamId: 's1',
      kind: 'cam',
    });

    expect(target.sent).toContainEqual({
      type: 'stream-meta',
      from: sender.data.userId,
      streamId: 's1',
      kind: 'cam',
    });
  });

  test('drops stream-meta to a target in a different workspace', () => {
    const sender = makeWs({ workspace: 'ws1', joined: true });
    const target = makeWs({ workspace: 'ws2', joined: true });
    handler.open!(sender);
    handler.open!(target);
    deliver(handler, sender, {
      type: 'stream-meta',
      to: target.data.userId,
      streamId: 's1',
      kind: 'cam',
    });
    expect(target.sent).toHaveLength(0);
  });

  test('drops stream-meta with an invalid kind or oversized streamId', () => {
    const sender = makeWs({ workspace: 'ws1', joined: true });
    const target = makeWs({ workspace: 'ws1', joined: true });
    handler.open!(sender);
    handler.open!(target);

    deliver(handler, sender, {
      type: 'stream-meta',
      to: target.data.userId,
      streamId: 's1',
      kind: 'bogus',
    });
    deliver(handler, sender, {
      type: 'stream-meta',
      to: target.data.userId,
      streamId: 'x'.repeat(200),
      kind: 'cam',
    });
    expect(target.sent).toHaveLength(0);
  });

  test('relays stream-meta with the removed sentinel kind', () => {
    const sender = makeWs({ workspace: 'ws1', joined: true });
    const target = makeWs({ workspace: 'ws1', joined: true });
    handler.open!(sender);
    handler.open!(target);
    deliver(handler, sender, {
      type: 'stream-meta',
      to: target.data.userId,
      streamId: 's1',
      kind: 'removed',
    });
    expect(target.sent).toContainEqual({
      type: 'stream-meta',
      from: sender.data.userId,
      streamId: 's1',
      kind: 'removed',
    });
  });
});

describe('createWebSocketHandler — error handling', () => {
  let clients: Map<string, ServerWebSocket<WsData>>;
  let handler: ReturnType<typeof createWebSocketHandler>;

  beforeEach(() => {
    clients = new Map();
    handler = createWebSocketHandler(clients);
  });

  test('ignores malformed JSON without throwing', () => {
    const ws = makeWs({ joined: true });
    handler.open!(ws);
    expect(() => handler.message!(ws, 'not-json{')).not.toThrow();
    expect(ws.sent).toHaveLength(0);
  });

  test('ignores an unknown message type without throwing', () => {
    const ws = makeWs({ workspace: 'ws1', joined: true });
    handler.open!(ws);
    expect(() => deliver(handler, ws, { type: 'totally-unknown', foo: 1 })).not.toThrow();
    expect(ws.sent).toHaveLength(0);
  });

  test('ignores a non-object JSON payload (null / number / string) without throwing', () => {
    const ws = makeWs({ workspace: 'ws1', joined: true });
    handler.open!(ws);
    expect(() => handler.message!(ws, 'null')).not.toThrow();
    expect(() => handler.message!(ws, '123')).not.toThrow();
    expect(() => handler.message!(ws, '"hello"')).not.toThrow();
    expect(ws.sent).toHaveLength(0);
  });

  test('ignores a message whose type is not a string', () => {
    const ws = makeWs({ workspace: 'ws1', joined: true });
    handler.open!(ws);
    expect(() => deliver(handler, ws, { type: 42 })).not.toThrow();
    expect(ws.sent).toHaveLength(0);
  });

  test('accepts a Buffer payload (non-string raw frame)', () => {
    const sender = makeWs({ workspace: 'ws1', joined: true });
    const peer = makeWs({ workspace: 'ws1', joined: true });
    handler.open!(sender);
    handler.open!(peer);

    const raw = Buffer.from(JSON.stringify({ type: 'move', x: 50, y: 60, vx: 0, vy: 0 }));
    handler.message!(sender, raw);

    expect(peer.sent).toContainEqual({
      type: 'player-moved',
      userId: sender.data.userId,
      x: 50,
      y: 60,
      vx: 0,
      vy: 0,
    });
  });
});

describe('createWebSocketHandler — SFU grouping', () => {
  let clients: Map<string, ServerWebSocket<WsData>>;
  let handler: ReturnType<typeof createWebSocketHandler>;

  beforeEach(() => {
    // Enable SFU for this suite so group-update / sfu-peer-tracks are emitted.
    process.env.CLOUDFLARE_REALTIME_APP_ID = 'test-app';
    process.env.CLOUDFLARE_REALTIME_APP_TOKEN = 'test-token';
    clients = new Map();
    // Tiny leave grace so the latch-cleanup test can await finalization (#187).
    handler = createWebSocketHandler(clients, undefined, 'dev', new Set(), Date.now, 10);
  });

  afterEach(() => {
    delete process.env.CLOUDFLARE_REALTIME_APP_ID;
    delete process.env.CLOUDFLARE_REALTIME_APP_TOKEN;
  });

  // Join a client into ws1 and move it to (x, y[, zone]) so the server has a
  // position + zone to group on.
  const joinAt = (x: number, y: number, zoneId: string | null = null): FakeWs => {
    const ws = makeWs();
    handler.open!(ws);
    deliver(handler, ws, { type: 'join', name: 'U', workspace: 'ws1' });
    deliver(handler, ws, { type: 'move', x, y, vx: 0, vy: 0, zoneId });
    return ws;
  };

  const lastGroupUpdate = (ws: FakeWs) =>
    [...ws.sent].reverse().find((m) => m.type === 'group-update');

  test('a meeting-room pair is told method=sfu with both members', () => {
    const a = joinAt(500, 500, 'meeting-1');
    const b = joinAt(600, 600, 'meeting-1');
    const ga = lastGroupUpdate(a);
    const gb = lastGroupUpdate(b);
    expect(ga?.type === 'group-update' && ga.method).toBe('sfu');
    expect(gb?.type === 'group-update' && gb.method).toBe('sfu');
    if (ga?.type === 'group-update') {
      expect(ga.members).toEqual([a.data.userId, b.data.userId].sort());
    }
  });

  test('an open-floor pair is told method=mesh with both members', () => {
    const a = joinAt(100, 100);
    const b = joinAt(140, 100); // within CONNECT_RADIUS, but only 2 people
    const ga = lastGroupUpdate(a);
    const gb = lastGroupUpdate(b);
    expect(ga?.type === 'group-update' && ga.method).toBe('mesh');
    expect(gb?.type === 'group-update' && gb.method).toBe('mesh');
    const both = [a.data.userId, b.data.userId].sort();
    if (ga?.type === 'group-update') expect(ga.members).toEqual(both);
    if (gb?.type === 'group-update') expect(gb.members).toEqual(both);
  });

  test('a far-apart open-floor pair are each their own single-member mesh group', () => {
    const a = joinAt(100, 100);
    const _b = joinAt(900, 100); // well beyond the disconnect radius
    const ga = lastGroupUpdate(a);
    expect(ga?.type === 'group-update' && ga.method).toBe('mesh');
    if (ga?.type === 'group-update') expect(ga.members).toEqual([a.data.userId]);
  });

  test('an open-floor cluster promotes to sfu at the 5th member', () => {
    const ws: FakeWs[] = [];
    for (let i = 0; i < 5; i++) ws.push(joinAt(100 + i * 10, 100));
    for (const w of ws) {
      const g = lastGroupUpdate(w);
      expect(g?.type === 'group-update' && g.method).toBe('sfu');
    }
  });

  test('sfu-publish relays the track directory to group peers', () => {
    const a = joinAt(500, 500, 'meeting-1');
    const b = joinAt(600, 600, 'meeting-1');
    deliver(handler, a, {
      type: 'sfu-publish',
      sessionId: 'sess-a',
      tracks: [{ kind: 'mic', trackName: 'a-mic' }],
    });
    const dir = b.sent.find((m) => m.type === 'sfu-peer-tracks');
    expect(dir).toBeDefined();
    if (dir?.type === 'sfu-peer-tracks') {
      expect(dir.userId).toBe(a.data.userId);
      expect(dir.sessionId).toBe('sess-a');
      expect(dir.tracks).toEqual([{ kind: 'mic', trackName: 'a-mic' }]);
    }
  });

  test('sfu-publish filters malformed track entries before relaying (#125)', () => {
    const a = joinAt(500, 500, 'meeting-1');
    const b = joinAt(600, 600, 'meeting-1');
    deliver(handler, a, {
      type: 'sfu-publish',
      sessionId: 'sess-a',
      tracks: [
        { kind: 'mic', trackName: 'a-mic' },
        { kind: 'bogus', trackName: 'x' },
        { kind: 'cam', trackName: '' },
        'garbage',
      ],
    });
    const dir = b.sent.find((m) => m.type === 'sfu-peer-tracks');
    if (dir?.type !== 'sfu-peer-tracks') throw new Error('expected sfu-peer-tracks');
    expect(dir.tracks).toEqual([{ kind: 'mic', trackName: 'a-mic' }]);
    // The connection's recorded directory is the filtered one too.
    expect(a.data.sfuTracks).toEqual([{ kind: 'mic', trackName: 'a-mic' }]);
  });

  test('a late joiner learns an existing member already-published tracks', () => {
    const a = joinAt(500, 500, 'meeting-1');
    deliver(handler, a, {
      type: 'sfu-publish',
      sessionId: 'sess-a',
      tracks: [{ kind: 'cam', trackName: 'a-cam' }],
    });
    const b = joinAt(550, 550, 'meeting-1');
    const dir = b.sent.find((m) => m.type === 'sfu-peer-tracks' && m.userId === a.data.userId);
    expect(dir).toBeDefined();
  });

  // Join a client with an explicit userId so we can re-use the same ids after a
  // workspace empties out (to probe whether stale latch state was discarded).
  const joinIdAt = (userId: string, x: number, y: number): FakeWs => {
    const ws = makeWs({ userId });
    handler.open!(ws);
    deliver(handler, ws, { type: 'join', name: 'U', workspace: 'ws1' });
    deliver(handler, ws, { type: 'move', x, y, vx: 0, vy: 0 });
    return ws;
  };

  test("an emptied workspace's SFU latch is discarded, so a later small group is mesh", async () => {
    // 5-member open-floor cluster promotes to SFU and seeds the one-way latch.
    const first: FakeWs[] = [];
    for (let i = 0; i < 5; i++) first.push(joinIdAt(`u${i}`, 100 + i * 10, 100));
    for (const w of first) {
      const g = lastGroupUpdate(w);
      expect(g?.type === 'group-update' && g.method).toBe('sfu');
    }

    // Everyone leaves. Joined connections wait out the resume grace (issue
    // #187) before their leave finalizes and the latch state is dropped.
    for (const w of first) handler.close!(w, 1000, '');
    await new Promise((r) => setTimeout(r, 30));
    expect(clients.size).toBe(0);

    // Two members with the SAME ids rejoin close together. If the stale latch
    // had survived, {u0,u1} would share a member with the old SFU seed and
    // wrongly stay SFU; with cleanup it correctly falls back to mesh.
    const a = joinIdAt('u0', 100, 100);
    const b = joinIdAt('u1', 140, 100);
    const ga = lastGroupUpdate(a);
    const gb = lastGroupUpdate(b);
    expect(ga?.type === 'group-update' && ga.method).toBe('mesh');
    expect(gb?.type === 'group-update' && gb.method).toBe('mesh');
  });
});

describe('createWebSocketHandler — chat', () => {
  let clients: Map<string, ServerWebSocket<WsData>>;
  let handler: ReturnType<typeof createWebSocketHandler>;

  beforeEach(() => {
    clients = new Map();
    handler = createWebSocketHandler(clients);
  });

  // Join + position a client so the proximity grouping has coordinates to work
  // with (chat is scoped to the sender's proximity group).
  const joinAt = (x: number, y: number): FakeWs => {
    const ws = makeWs();
    handler.open!(ws);
    deliver(handler, ws, { type: 'join', name: 'U', workspace: 'ws1' });
    deliver(handler, ws, { type: 'move', x, y, vx: 0, vy: 0 });
    return ws;
  };

  test('relays a chat line to the sender and a nearby peer, but not a distant one', () => {
    const a = joinAt(100, 100);
    const near = joinAt(150, 100); // within CONNECT_RADIUS of a
    const far = joinAt(1500, 1200); // its own proximity group

    deliver(handler, a, { type: 'chat', text: 'hello' });

    const chatOf = (ws: FakeWs) => ws.sent.find((m) => m.type === 'chat');
    // Sender sees their own echo.
    expect(chatOf(a)).toMatchObject({
      type: 'chat',
      from: a.data.userId,
      name: 'U',
      text: 'hello',
    });
    // Nearby peer receives it.
    expect(chatOf(near)).toMatchObject({ type: 'chat', from: a.data.userId, text: 'hello' });
    // Distant peer does not.
    expect(chatOf(far)).toBeUndefined();
  });

  test('trims and drops an empty chat message', () => {
    const a = joinAt(100, 100);
    deliver(handler, a, { type: 'chat', text: '   ' });
    expect(a.sent.some((m) => m.type === 'chat')).toBe(false);
  });

  test('ignores chat from a client that has not joined', () => {
    const a = makeWs({ workspace: 'ws1', joined: false });
    handler.open!(a);
    deliver(handler, a, { type: 'chat', text: 'hi' });
    expect(a.sent.some((m) => m.type === 'chat')).toBe(false);
  });

  test('a peer held in the call by hysteresis (120-150px) still receives chat', () => {
    // Uses an injected clock so the second move actually recomputes groups
    // (past the per-connection throttle). The pair forms at the same spot, then
    // one drifts to 135px — beyond the 120px connect radius but within the 150px
    // disconnect radius, so the group hysteresis keeps them together. Chat must
    // follow that real call group, not a fresh connect-radius-only recompute.
    let t = 1000;
    const now = () => t;
    const clients2 = new Map<string, ServerWebSocket<WsData>>();
    const h = createWebSocketHandler(clients2, undefined, 'dev', new Set(), now);
    const move = (ws: FakeWs, x: number, y: number) =>
      deliver(h, ws, { type: 'move', x, y, vx: 0, vy: 0 });

    const a = makeWs();
    h.open!(a);
    deliver(h, a, { type: 'join', name: 'A', workspace: 'ws1' });
    move(a, 100, 100);

    const b = makeWs();
    h.open!(b);
    deliver(h, b, { type: 'join', name: 'B', workspace: 'ws1' });
    move(b, 100, 100); // same spot → grouped

    t = 2000;
    move(b, 235, 100); // 135px from a: past connect (120), within disconnect (150)

    deliver(h, a, { type: 'chat', text: 'still here?' });
    expect(b.sent.some((m) => m.type === 'chat' && m.text === 'still here?')).toBe(true);
  });
});

describe('createWebSocketHandler — move group-recompute throttle', () => {
  test('a burst of moves from one socket within the window recomputes groups once', () => {
    let t = 1000;
    const now = () => t;
    const clients = new Map<string, ServerWebSocket<WsData>>();
    const h = createWebSocketHandler(clients, undefined, 'dev', new Set(), now);

    const mover = makeWs();
    const peer = makeWs();
    h.open!(mover);
    h.open!(peer);
    deliver(h, mover, { type: 'join', name: 'M', workspace: 'ws1' });
    deliver(h, peer, { type: 'join', name: 'P', workspace: 'ws1' });
    // Position both far apart so they start as separate single-member groups.
    deliver(h, mover, { type: 'move', x: 900, y: 100, vx: 0, vy: 0 });
    deliver(h, peer, { type: 'move', x: 100, y: 100, vx: 0, vy: 0 });

    const groupMembersLen = (ws: FakeWs): number => {
      const g = [...ws.sent].reverse().find((m) => m.type === 'group-update');
      return g?.type === 'group-update' ? g.members.length : 0;
    };
    expect(groupMembersLen(mover)).toBe(1);

    // A move into range 10ms later is throttled: the position/relay happen but the
    // O(n²) group recompute is skipped, so the pairing is not reflected yet.
    t = 1010;
    deliver(h, mover, { type: 'move', x: 140, y: 100, vx: 0, vy: 0 });
    expect(peer.sent.some((m) => m.type === 'player-moved')).toBe(true);
    expect(groupMembersLen(mover)).toBe(1);

    // Past the window the recompute runs and the pair is grouped.
    t = 1050;
    deliver(h, mover, { type: 'move', x: 141, y: 100, vx: 0, vy: 0 });
    expect(groupMembersLen(mover)).toBe(2);
  });
});

describe('createWebSocketHandler — reaction', () => {
  let clients: Map<string, ServerWebSocket<WsData>>;
  let handler: ReturnType<typeof createWebSocketHandler>;

  beforeEach(() => {
    clients = new Map();
    handler = createWebSocketHandler(clients);
  });

  test('broadcasts a whitelisted reaction to the whole workspace, including the sender', () => {
    const a = makeWs({ workspace: 'ws1', joined: true });
    const b = makeWs({ workspace: 'ws1', joined: true });
    handler.open!(a);
    handler.open!(b);

    deliver(handler, a, { type: 'reaction', emoji: '👍' });

    const reaction = { type: 'reaction' as const, userId: a.data.userId, emoji: '👍' };
    // Sender sees their own bubble (no exceptUserId), and the peer sees it too.
    expect(a.sent).toContainEqual(reaction);
    expect(b.sent).toContainEqual(reaction);
  });

  test('drops a reaction that is not on the whitelist', () => {
    const a = makeWs({ workspace: 'ws1', joined: true });
    const b = makeWs({ workspace: 'ws1', joined: true });
    handler.open!(a);
    handler.open!(b);

    deliver(handler, a, { type: 'reaction', emoji: '🔥' });

    expect(a.sent.some((m) => m.type === 'reaction')).toBe(false);
    expect(b.sent.some((m) => m.type === 'reaction')).toBe(false);
  });

  test('does not deliver a reaction to a different workspace', () => {
    const a = makeWs({ workspace: 'ws1', joined: true });
    const other = makeWs({ workspace: 'ws2', joined: true });
    handler.open!(a);
    handler.open!(other);

    deliver(handler, a, { type: 'reaction', emoji: '🎉' });

    expect(other.sent.some((m) => m.type === 'reaction')).toBe(false);
  });

  test('ignores a reaction from a client that has not joined', () => {
    const a = makeWs({ workspace: 'ws1', joined: false });
    handler.open!(a);
    deliver(handler, a, { type: 'reaction', emoji: '👍' });
    expect(a.sent.some((m) => m.type === 'reaction')).toBe(false);
  });
});

describe('createWebSocketHandler — knock', () => {
  let clients: Map<string, ServerWebSocket<WsData>>;
  let handler: ReturnType<typeof createWebSocketHandler>;

  beforeEach(() => {
    clients = new Map();
    handler = createWebSocketHandler(clients);
  });

  test('relays a knock only to the named target with sender name', () => {
    const sender = makeWs({ workspace: 'ws1', joined: true, name: 'Alice' });
    const target = makeWs({ workspace: 'ws1', joined: true });
    const bystander = makeWs({ workspace: 'ws1', joined: true });
    handler.open!(sender);
    handler.open!(target);
    handler.open!(bystander);

    deliver(handler, sender, { type: 'knock', to: target.data.userId });

    expect(target.sent).toContainEqual({
      type: 'knock',
      from: sender.data.userId,
      name: 'Alice',
    });
    expect(bystander.sent).toHaveLength(0);
  });

  test('relays a knock-reply (accept) back to the named target', () => {
    const replier = makeWs({ workspace: 'ws1', joined: true, name: 'Bob' });
    const knocker = makeWs({ workspace: 'ws1', joined: true });
    handler.open!(replier);
    handler.open!(knocker);

    deliver(handler, replier, { type: 'knock-reply', to: knocker.data.userId, accept: true });

    expect(knocker.sent).toContainEqual({
      type: 'knock-reply',
      from: replier.data.userId,
      name: 'Bob',
      accept: true,
    });
  });

  test('drops a knock to a target in a different workspace', () => {
    const sender = makeWs({ workspace: 'ws1', joined: true });
    const target = makeWs({ workspace: 'ws2', joined: true });
    handler.open!(sender);
    handler.open!(target);
    deliver(handler, sender, { type: 'knock', to: target.data.userId });
    expect(target.sent).toHaveLength(0);
  });

  test('drops a knock to an unknown or unjoined target', () => {
    const sender = makeWs({ workspace: 'ws1', joined: true });
    const unjoined = makeWs({ workspace: 'ws1', joined: false });
    handler.open!(sender);
    handler.open!(unjoined);
    deliver(handler, sender, { type: 'knock', to: 'ghost' });
    deliver(handler, sender, { type: 'knock', to: unjoined.data.userId });
    expect(unjoined.sent).toHaveLength(0);
  });
});

describe('createWebSocketHandler — heartbeat', () => {
  test('answers ping with pong, before and after join', () => {
    const clients = new Map<string, ServerWebSocket<WsData>>();
    const handler = createWebSocketHandler(clients);
    const ws = makeWs();
    handler.open!(ws);

    deliver(handler, ws, { type: 'ping' });
    expect(ws.sent).toContainEqual({ type: 'pong' });

    deliver(handler, ws, { type: 'join', name: 'A' });
    ws.sent.length = 0;
    deliver(handler, ws, { type: 'ping' });
    expect(ws.sent).toContainEqual({ type: 'pong' });
  });

  test('configures explicit dead-peer detection', () => {
    const handler = createWebSocketHandler(new Map());
    expect(handler.idleTimeout).toBe(30);
    expect(handler.sendPings).toBe(true);
  });
});

describe('createWebSocketHandler — rtc-restart relay', () => {
  test('relays the nudge 1:1 within the workspace', () => {
    const clients = new Map<string, ServerWebSocket<WsData>>();
    const handler = createWebSocketHandler(clients);
    const a = makeWs({ workspace: 'ws1', joined: true });
    const b = makeWs({ workspace: 'ws1', joined: true });
    handler.open!(a);
    handler.open!(b);

    deliver(handler, a, { type: 'rtc-restart', to: b.data.userId });
    expect(b.sent).toContainEqual({ type: 'rtc-restart', from: a.data.userId });
  });

  test('drops the nudge across workspaces and for unjoined senders', () => {
    const clients = new Map<string, ServerWebSocket<WsData>>();
    const handler = createWebSocketHandler(clients);
    const a = makeWs({ workspace: 'ws1', joined: true });
    const other = makeWs({ workspace: 'ws2', joined: true });
    const lurker = makeWs({ workspace: 'ws1', joined: false });
    handler.open!(a);
    handler.open!(other);
    handler.open!(lurker);

    deliver(handler, a, { type: 'rtc-restart', to: other.data.userId });
    expect(other.sent).toHaveLength(0);

    deliver(handler, lurker, { type: 'rtc-restart', to: a.data.userId });
    expect(a.sent).toHaveLength(0);
  });
});

describe('createWebSocketHandler — session resume (issue #187)', () => {
  function joinedWelcome(ws: FakeWs) {
    return ws.sent.find((m) => m.type === 'welcome') as Extract<ServerMessage, { type: 'welcome' }>;
  }

  function setup(graceMs = 30_000) {
    const clients = new Map<string, ServerWebSocket<WsData>>();
    const mediaTokens = new Set<string>();
    const handler = createWebSocketHandler(
      clients,
      undefined,
      'boot',
      mediaTokens,
      Date.now,
      graceMs,
    );
    return { clients, mediaTokens, handler };
  }

  test('welcome carries a resume token on a fresh join', () => {
    const { handler } = setup();
    const ws = makeWs();
    handler.open!(ws);
    deliver(handler, ws, { type: 'join', name: 'A' });
    const w = joinedWelcome(ws);
    expect(typeof w.resumeToken).toBe('string');
    expect(w.resumed).toBeUndefined();
  });

  test('a reconnect within the grace window resumes identity without leave/join noise', () => {
    const { clients, mediaTokens, handler } = setup();
    const a = makeWs();
    const peer = makeWs();
    handler.open!(a);
    handler.open!(peer);
    deliver(handler, a, { type: 'join', name: 'A' });
    deliver(handler, peer, { type: 'join', name: 'P' });
    const firstWelcome = joinedWelcome(a);
    const oldUserId = a.data.userId;
    const oldMediaToken = a.data.mediaToken!;
    peer.sent.length = 0;

    handler.close!(a, 1006, '');
    // Grace: presence and media token survive, no player-left yet.
    expect(clients.get(oldUserId)).toBe(a);
    expect(mediaTokens.has(oldMediaToken)).toBe(true);
    expect(peer.sent.some((m) => m.type === 'player-left')).toBe(false);

    const b = makeWs();
    handler.open!(b);
    deliver(handler, b, { type: 'join', name: 'A', resumeToken: firstWelcome.resumeToken });

    // Identity adopted: same userId, presence points at the new socket.
    expect(b.data.userId).toBe(oldUserId);
    expect(clients.get(oldUserId)).toBe(b);
    const w = joinedWelcome(b);
    expect(w.resumed).toBe(true);
    expect(w.self.userId).toBe(oldUserId);
    // Token rotation: media token replaced, resume token single-use.
    expect(mediaTokens.has(oldMediaToken)).toBe(false);
    expect(mediaTokens.has(w.token)).toBe(true);
    expect(w.resumeToken).not.toBe(firstWelcome.resumeToken);
    // Peers saw neither a leave nor a join.
    expect(peer.sent.some((m) => m.type === 'player-left')).toBe(false);
    expect(peer.sent.some((m) => m.type === 'player-joined')).toBe(false);
  });

  test('the grace timer finalizes the leave when nobody resumes', async () => {
    const { clients, mediaTokens, handler } = setup(10);
    const a = makeWs();
    const peer = makeWs();
    handler.open!(a);
    handler.open!(peer);
    deliver(handler, a, { type: 'join', name: 'A' });
    deliver(handler, peer, { type: 'join', name: 'P' });
    const oldUserId = a.data.userId;
    const oldMediaToken = a.data.mediaToken!;
    peer.sent.length = 0;

    handler.close!(a, 1006, '');
    await new Promise((r) => setTimeout(r, 30));

    expect(clients.has(oldUserId)).toBe(false);
    expect(mediaTokens.has(oldMediaToken)).toBe(false);
    expect(peer.sent).toContainEqual({ type: 'player-left', userId: oldUserId });
  });

  test('a half-open predecessor is taken over even before its close arrives', () => {
    const { clients, handler } = setup();
    const a = makeWs();
    handler.open!(a);
    deliver(handler, a, { type: 'join', name: 'A' });
    const firstWelcome = joinedWelcome(a);
    const oldUserId = a.data.userId;

    // No close for `a` — the server never noticed the drop. A new connection
    // presents the token: it must win, and the zombie gets closed.
    const b = makeWs();
    handler.open!(b);
    deliver(handler, b, { type: 'join', name: 'A', resumeToken: firstWelcome.resumeToken });

    expect(b.data.userId).toBe(oldUserId);
    expect(clients.get(oldUserId)).toBe(b);
    expect(a.closed).not.toBeNull();
    // The zombie's late close must not evict the resumed connection.
    handler.close!(a, 1006, '');
    expect(clients.get(oldUserId)).toBe(b);
  });

  test('an unknown or replayed resume token falls back to a fresh join', () => {
    const { handler } = setup();
    const peer = makeWs();
    handler.open!(peer);
    deliver(handler, peer, { type: 'join', name: 'P' });
    peer.sent.length = 0;

    const b = makeWs();
    handler.open!(b);
    deliver(handler, b, { type: 'join', name: 'B', resumeToken: 'no-such-token' });
    const w = joinedWelcome(b);
    expect(w.resumed).toBeUndefined();
    expect(peer.sent.some((m) => m.type === 'player-joined')).toBe(true);
  });

  test('a resumed connection keeps position and group key', () => {
    const { handler } = setup();
    const a = makeWs();
    handler.open!(a);
    deliver(handler, a, { type: 'join', name: 'A' });
    const firstWelcome = joinedWelcome(a);
    // Simulate in-room state accumulated before the drop.
    deliver(handler, a, { type: 'move', x: 321, y: 123, vx: 0, vy: 0 });
    const groupKey = a.data.groupKey;

    handler.close!(a, 1006, '');
    const b = makeWs();
    handler.open!(b);
    deliver(handler, b, { type: 'join', name: 'A', resumeToken: firstWelcome.resumeToken });

    const w = joinedWelcome(b);
    expect(w.resumed).toBe(true);
    expect(w.self.x).toBe(321);
    expect(w.self.y).toBe(123);
    expect(b.data.groupKey).toBe(groupKey);
  });
});
