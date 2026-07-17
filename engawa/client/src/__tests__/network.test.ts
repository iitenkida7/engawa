import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { NetworkClient } from '@/core/network';
import type { ServerMessage } from '@/core/types';

// Minimal fake WebSocket capturing listeners and sent payloads.
class FakeWebSocket {
  static OPEN = 1;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  url: string;
  readyState = FakeWebSocket.OPEN;
  sent: string[] = [];
  private listeners: Record<string, ((e: any) => void)[]> = {};

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }
  addEventListener(type: string, fn: (e: any) => void) {
    (this.listeners[type] ??= []).push(fn);
  }
  send(data: string) {
    this.sent.push(data);
  }
  // A real WebSocket.close() transitions the socket and later fires 'close';
  // mirror that so the identity-guard tests can drive a stale close.
  close() {
    this.readyState = FakeWebSocket.CLOSED;
    this.emit('close');
  }
  // Test helpers to drive events.
  emit(type: string, e?: any) {
    for (const fn of this.listeners[type] ?? []) fn(e);
  }
}

describe('NetworkClient', () => {
  let onMessage: ReturnType<typeof mock>;
  let onOpen: ReturnType<typeof mock>;
  let onClose: ReturnType<typeof mock>;
  let realWebSocket: typeof WebSocket;
  let restoreErr: (() => void) | undefined;

  beforeEach(() => {
    FakeWebSocket.instances = [];
    // Save the native WebSocket and swap in the fake; bun:test has no
    // vi.stubGlobal, so we restore it manually in afterEach.
    realWebSocket = globalThis.WebSocket;
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    onMessage = mock();
    onOpen = mock();
    onClose = mock();
  });

  afterEach(() => {
    globalThis.WebSocket = realWebSocket;
    restoreErr?.();
    restoreErr = undefined;
  });

  function make() {
    return new NetworkClient({ onMessage, onOpen, onClose });
  }

  it('builds a ws/wss URL ending in /ws', () => {
    make().connect();
    const sock = FakeWebSocket.instances[0];
    expect(sock.url).toMatch(/^wss?:\/\/.+\/ws$/);
  });

  it('invokes onOpen when the socket opens', () => {
    make().connect();
    FakeWebSocket.instances[0].emit('open');
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('invokes onClose when the socket closes', () => {
    make().connect();
    FakeWebSocket.instances[0].emit('close');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('parses incoming JSON and forwards the message to the handler', () => {
    make().connect();
    const msg: ServerMessage = { type: 'player-left', userId: 'u9' };
    FakeWebSocket.instances[0].emit('message', { data: JSON.stringify(msg) });
    expect(onMessage).toHaveBeenCalledWith(msg);
  });

  it('swallows invalid JSON without calling the handler', () => {
    const errSpy = spyOn(console, 'error').mockImplementation(() => {});
    restoreErr = () => errSpy.mockRestore();
    make().connect();
    FakeWebSocket.instances[0].emit('message', { data: '{not json' });
    expect(onMessage).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalled();
  });

  it('serializes outgoing messages as JSON when the socket is OPEN', () => {
    const client = make();
    client.connect();
    client.send({ type: 'move', x: 1, y: 2, vx: 3, vy: 4 });
    expect(FakeWebSocket.instances[0].sent).toEqual([
      JSON.stringify({ type: 'move', x: 1, y: 2, vx: 3, vy: 4 }),
    ]);
  });

  it('does not send before connect()', () => {
    const client = make();
    client.send({ type: 'move', x: 0, y: 0, vx: 0, vy: 0 });
    expect(FakeWebSocket.instances.length).toBe(0);
  });

  it('does not send when the socket is not OPEN', () => {
    const client = make();
    client.connect();
    FakeWebSocket.instances[0].readyState = FakeWebSocket.CLOSED;
    client.send({ type: 'move', x: 0, y: 0, vx: 0, vy: 0 });
    expect(FakeWebSocket.instances[0].sent).toEqual([]);
  });

  it('ignores events from an abandoned socket after reconnect', () => {
    const client = make();
    client.connect();
    const first = FakeWebSocket.instances[0];

    // Reconnect: the second connect() closes the first socket (firing its close),
    // but the identity guard must suppress onClose so it doesn't schedule a
    // spurious reconnect over the live one.
    client.connect();
    const second = FakeWebSocket.instances[1];
    expect(onClose).not.toHaveBeenCalled();

    // A late open/message/close from the abandoned first socket is ignored.
    first.emit('open');
    first.emit('message', { data: JSON.stringify({ type: 'player-left', userId: 'x' }) });
    first.emit('close');
    expect(onOpen).not.toHaveBeenCalled();
    expect(onMessage).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();

    // The live (second) socket still drives the callbacks.
    second.emit('open');
    second.emit('close');
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
