import { describe, expect, test } from 'bun:test';
import type { ServerWebSocket } from 'bun';
import {
  createEventRecorder,
  createEventRecorderFromEnv,
  createWebhookEmit,
  type EventData,
  type EventType,
  type GroupSnapshot,
  type OpenConversation,
  participantLabel,
  trackConversations,
} from '../events';
import type { WsData } from '../types';
import { createWebSocketHandler } from '../websocket';

const T0 = Date.parse('2026-10-24T01:00:00.000Z');

describe('participantLabel', () => {
  test('returns the name as-is when names are included', () => {
    expect(participantLabel('Aki', true, 'salt', T0)).toBe('Aki');
  });

  test('is an opaque id, stable for the same name/day/salt', () => {
    const a = participantLabel('Aki', false, 'salt', T0);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(a).not.toContain('Aki');
    expect(participantLabel('Aki', false, 'salt', T0 + 3600_000)).toBe(a);
  });

  test('differs across names, days and salts', () => {
    const a = participantLabel('Aki', false, 'salt', T0);
    expect(participantLabel('Ben', false, 'salt', T0)).not.toBe(a);
    expect(participantLabel('Aki', false, 'salt', T0 + 86_400_000)).not.toBe(a);
    expect(participantLabel('Aki', false, 'other', T0)).not.toBe(a);
  });
});

describe('trackConversations', () => {
  let seq = 0;
  const newId = () => `c${seq++}`;
  const label = (id: string) => `L-${id}`;
  const g = (memberIds: string[], zone: string | null = null): GroupSnapshot => ({
    memberIds,
    method: 'sfu',
    zone,
  });
  const step = (open: OpenConversation[], groups: GroupSnapshot[], t = T0) =>
    trackConversations(open, groups, t, newId, label);

  test('a group of two starts a conversation; solo groups do not', () => {
    const r = step([], [g(['a', 'b']), g(['c'])]);
    expect(r.started).toHaveLength(1);
    expect(r.started[0].memberIds).toEqual(['a', 'b']);
    expect([...r.started[0].participants.values()]).toEqual(['L-a', 'L-b']);
    expect(r.ended).toHaveLength(0);
    expect(r.open).toHaveLength(1);
  });

  test('someone joining keeps the conversation and grows its counts', () => {
    const first = step([], [g(['a', 'b'])]);
    const r = step(first.open, [g(['a', 'b', 'c'])], T0 + 1000);
    expect(r.started).toHaveLength(0);
    expect(r.ended).toHaveLength(0);
    expect(r.open[0].id).toBe(first.open[0].id);
    expect(r.open[0].startedAt).toBe(T0);
    expect(r.open[0].participants.size).toBe(3);
    expect(r.open[0].maxConcurrent).toBe(3);
  });

  test('participants are remembered after they leave', () => {
    let open = step([], [g(['a', 'b', 'c'])]).open;
    open = step(open, [g(['a', 'b']), g(['c'])]).open;
    expect(open[0].participants.size).toBe(3);
    expect(open[0].maxConcurrent).toBe(3);
  });

  test('shrinking to one person ends it', () => {
    const first = step([], [g(['a', 'b'])]);
    const r = step(first.open, [g(['a']), g(['b'])]);
    expect(r.ended.map((c) => c.id)).toEqual([first.open[0].id]);
    expect(r.open).toHaveLength(0);
  });

  test('moving to another zone ends it and starts a new one', () => {
    const first = step([], [g(['a', 'b'])]);
    const r = step(first.open, [g(['a', 'b'], 'meeting-1')]);
    expect(r.ended).toHaveLength(1);
    expect(r.started).toHaveLength(1);
    expect(r.started[0].zone).toBe('meeting-1');
  });

  test('on a split the larger part continues and the rest starts anew', () => {
    const first = step([], [g(['a', 'b', 'c', 'd', 'e'])]);
    const r = step(first.open, [g(['a', 'b', 'c']), g(['d', 'e'])]);
    expect(r.ended).toHaveLength(0);
    expect(r.started.map((c) => c.memberIds)).toEqual([['d', 'e']]);
    expect(r.open.find((c) => c.memberIds.includes('a'))?.id).toBe(first.open[0].id);
  });

  test('on a merge one continues and the other ends', () => {
    const first = step([], [g(['a', 'b', 'c']), g(['d', 'e'])]);
    const r = step(first.open, [g(['a', 'b', 'c', 'd', 'e'])]);
    expect(r.started).toHaveLength(0);
    expect(r.ended.map((c) => c.memberIds)).toEqual([['d', 'e']]);
    expect(r.open).toHaveLength(1);
  });
});

describe('createEventRecorder', () => {
  const setup = () => {
    const events: { type: EventType; data: EventData }[] = [];
    let t = T0;
    const rec = createEventRecorder((type, data) => events.push({ type, data }), {
      includeNames: true,
      now: () => t,
    });
    return { events, rec, advance: (ms: number) => (t += ms) };
  };

  test('presence started/ended carries the stay duration', () => {
    const { events, rec, advance } = setup();
    rec.presenceStarted('u1', 'Aki');
    advance(90_000);
    rec.presenceEnded('u1');
    expect(events).toEqual([
      { type: 'presence.started', data: { presenceId: 'u1', participant: 'Aki' } },
      {
        type: 'presence.ended',
        data: {
          presenceId: 'u1',
          participant: 'Aki',
          joinedAt: '2026-10-24T01:00:00.000Z',
          leftAt: '2026-10-24T01:01:30.000Z',
          durationSec: 90,
        },
      },
    ]);
  });

  test('presenceEnded without a start is ignored', () => {
    const { events, rec } = setup();
    rec.presenceEnded('nobody');
    expect(events).toHaveLength(0);
  });

  test('a conversation emits started then ended with its summary', () => {
    const { events, rec, advance } = setup();
    rec.presenceStarted('u1', 'Aki');
    rec.presenceStarted('u2', 'Ben');
    events.length = 0;
    const pair = { memberIds: ['u1', 'u2'], method: 'sfu' as const, zone: 'meeting-1' };
    rec.groupsChanged('ws', [pair]);
    rec.groupsChanged('ws', [pair]); // unchanged recompute: nothing new
    advance(300_000);
    rec.groupsChanged('ws', []);
    expect(events.map((e) => e.type)).toEqual(['conversation.started', 'conversation.ended']);
    const started = events[0].data;
    const ended = events[1].data;
    expect(started).toMatchObject({
      zone: 'meeting-1',
      transport: 'sfu',
      participants: ['Aki', 'Ben'],
      participantCount: 2,
    });
    expect(ended).toMatchObject({
      conversationId: started.conversationId,
      zone: 'meeting-1',
      startedAt: '2026-10-24T01:00:00.000Z',
      endedAt: '2026-10-24T01:05:00.000Z',
      durationSec: 300,
      participants: ['Aki', 'Ben'],
      participantCount: 2,
      maxConcurrent: 2,
    });
  });
});

describe('createWebhookEmit', () => {
  const capture = () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchFn = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;
    return { calls, fetchFn };
  };

  test('POSTs the event envelope as JSON', () => {
    const { calls, fetchFn } = capture();
    createWebhookEmit(
      'https://hook.example/x',
      undefined,
      fetchFn,
      () => T0,
    )('presence.started', {
      presenceId: 'u1',
    });
    expect(calls).toHaveLength(1);
    const { url, init } = calls[0];
    expect(url).toBe('https://hook.example/x');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['content-type']).toBe('application/json');
    expect(headers['x-engawa-event']).toBe('presence.started');
    expect(headers['x-engawa-signature']).toBeUndefined();
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({
      type: 'presence.started',
      at: '2026-10-24T01:00:00.000Z',
      data: { presenceId: 'u1' },
    });
    expect(body.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  test('signs the raw body with the secret', async () => {
    const { calls, fetchFn } = capture();
    createWebhookEmit('https://hook.example/x', 's3cret', fetchFn)('presence.started', {});
    const { init } = calls[0];
    const sig = (init.headers as Record<string, string>)['x-engawa-signature'];
    const hasher = new Bun.CryptoHasher('sha256', 's3cret');
    hasher.update(init.body as string);
    expect(sig).toBe(`sha256=${hasher.digest('hex')}`);
  });

  test('a failing receiver does not throw', async () => {
    const fetchFn = (async () => {
      throw new Error('down');
    }) as unknown as typeof fetch;
    expect(() =>
      createWebhookEmit('https://hook.example/x', undefined, fetchFn)('presence.started', {}),
    ).not.toThrow();
    await Bun.sleep(0);
  });
});

describe('createEventRecorderFromEnv', () => {
  test('is null when the URL is unset or not http(s)', () => {
    expect(createEventRecorderFromEnv({})).toBeNull();
    expect(createEventRecorderFromEnv({ EVENT_WEBHOOK_URL: '  ' })).toBeNull();
    expect(createEventRecorderFromEnv({ EVENT_WEBHOOK_URL: 'ftp://x' })).toBeNull();
    expect(createEventRecorderFromEnv({ EVENT_WEBHOOK_URL: 'not a url' })).toBeNull();
  });

  test('is a recorder for an https URL', () => {
    expect(
      createEventRecorderFromEnv({ EVENT_WEBHOOK_URL: 'https://hook.example/x' }),
    ).not.toBeNull();
  });
});

describe('websocket handler → events', () => {
  const makeWs = (): ServerWebSocket<WsData> => {
    const data = {
      userId: crypto.randomUUID(),
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
    } satisfies WsData;
    return { data, send: () => 0, close: () => {} } as unknown as ServerWebSocket<WsData>;
  };

  test('join, meeting-room conversation and leave produce events', () => {
    const events: { type: EventType; data: EventData }[] = [];
    const rec = createEventRecorder((type, data) => events.push({ type, data }), {
      includeNames: true,
    });
    const clients = new Map<string, ServerWebSocket<WsData>>();
    const handler = createWebSocketHandler(clients, undefined, 'dev', new Set(), Date.now, 10, rec);
    const joinAt = (name: string, x: number, y: number) => {
      const ws = makeWs();
      handler.open!(ws);
      handler.message!(ws, JSON.stringify({ type: 'join', name, workspace: 'ws1' }));
      ws.data.x = x;
      ws.data.y = y;
      handler.message!(
        ws,
        JSON.stringify({ type: 'move', x, y, vx: 0, vy: 0, zoneId: 'meeting-1' }),
      );
      return ws;
    };

    joinAt('Aki', 500, 500);
    const b = joinAt('Ben', 600, 600);
    handler.close!(b, 1000, '');

    expect(events.map((e) => e.type)).toEqual([
      'presence.started',
      'presence.started',
      'conversation.started',
      'presence.ended',
      'conversation.ended',
    ]);
    expect(events[2].data).toMatchObject({ zone: 'meeting-1', participantCount: 2 });
    expect([...(events[2].data.participants as string[])].sort()).toEqual(['Aki', 'Ben']);
    expect(events[3].data).toMatchObject({ participant: 'Ben' });
  });
});
