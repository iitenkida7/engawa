import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { ServerWebSocket } from 'bun';
import { createWebSocketHandler } from '../websocket';
import type { ServerMessage, WsData } from '../types';

// Minimal fake of ServerWebSocket<WsData> that records everything the handler
// sends and any close() call. Only the surface the handler actually touches is
// implemented; the rest is cast away.
type FakeWs = ServerWebSocket<WsData> & {
  sent: ServerMessage[];
  closed: { code?: number; reason?: string } | null;
};

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
      sfuSessionId: data.sfuSessionId ?? null,
      sfuTracks: data.sfuTracks ?? [],
      groupKey: data.groupKey ?? null,
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
function deliver(
  handler: ReturnType<typeof createWebSocketHandler>,
  ws: FakeWs,
  msg: unknown,
) {
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
    expect(welcome.players[0]).toMatchObject({ userId: existing.data.userId, name: 'Bob', x: 10, y: 20 });
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
    const handler = createWebSocketHandler(clients, new Map([['locked', 'secret']]));
    const joiner = makeWs();
    handler.open!(joiner);
    deliver(handler, joiner, { type: 'join', name: 'Alice', workspace: 'locked', password: 'wrong' });

    expect(joiner.sent).toContainEqual({
      type: 'auth-error',
      message: 'パスワードが正しくありません',
    });
    expect(joiner.closed).toEqual({ code: 4001, reason: 'auth failed' });
    expect(joiner.data.joined).toBe(false);
  });

  test('accepts a join with the correct password', () => {
    const handler = createWebSocketHandler(clients, new Map([['locked', 'secret']]));
    const joiner = makeWs();
    handler.open!(joiner);
    deliver(handler, joiner, { type: 'join', name: 'Alice', workspace: 'locked', password: 'secret' });

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
      x: 2000,
      y: 0,
      vx: 1,
      vy: -2,
    });
    // Server-side state is updated to the clamped value.
    expect(mover.data.x).toBe(2000);
    expect(mover.data.y).toBe(0);
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
    });
  });

  test('relays stream-meta only to the named target', () => {
    const sender = makeWs({ workspace: 'ws1', joined: true });
    const target = makeWs({ workspace: 'ws1', joined: true });
    handler.open!(sender);
    handler.open!(target);

    deliver(handler, sender, { type: 'stream-meta', to: target.data.userId, streamId: 's1', kind: 'cam' });

    expect(target.sent).toContainEqual({
      type: 'stream-meta',
      from: sender.data.userId,
      streamId: 's1',
      kind: 'cam',
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
    handler = createWebSocketHandler(clients);
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

  test('an open-floor pair stays mesh (no group-update is sent)', () => {
    const a = joinAt(100, 100);
    const b = joinAt(140, 100); // within CONNECT_RADIUS, but only 2 people
    expect(a.sent.some((m) => m.type === 'group-update')).toBe(false);
    expect(b.sent.some((m) => m.type === 'group-update')).toBe(false);
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

  test('a late joiner learns an existing member already-published tracks', () => {
    const a = joinAt(500, 500, 'meeting-1');
    deliver(handler, a, {
      type: 'sfu-publish',
      sessionId: 'sess-a',
      tracks: [{ kind: 'cam', trackName: 'a-cam' }],
    });
    const b = joinAt(550, 550, 'meeting-1');
    const dir = b.sent.find(
      (m) => m.type === 'sfu-peer-tracks' && m.userId === a.data.userId,
    );
    expect(dir).toBeDefined();
  });
});
