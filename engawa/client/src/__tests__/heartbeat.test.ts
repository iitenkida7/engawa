import { describe, expect, it } from 'bun:test';
import {
  CONNECT_TIMEOUT_MS,
  HEARTBEAT_PING_INTERVAL_MS,
  HEARTBEAT_PONG_TIMEOUT_MS,
  heartbeatAction,
} from '@/core/heartbeat';

const base = { phase: 'open' as const, connectingMs: 0, sincePingMs: 0, sincePongMs: 0 };

describe('heartbeatAction', () => {
  it('does nothing while idle (no socket)', () => {
    expect(heartbeatAction({ ...base, phase: 'idle' })).toBe('none');
  });

  it('waits out a normal handshake but abandons a hung CONNECT', () => {
    expect(heartbeatAction({ ...base, phase: 'connecting', connectingMs: 500 })).toBe('none');
    expect(
      heartbeatAction({ ...base, phase: 'connecting', connectingMs: CONNECT_TIMEOUT_MS + 1 }),
    ).toBe('timeout');
  });

  it('pings once the interval elapses, including immediately after open', () => {
    expect(heartbeatAction({ ...base, sincePingMs: HEARTBEAT_PING_INTERVAL_MS - 1 })).toBe('none');
    expect(heartbeatAction({ ...base, sincePingMs: HEARTBEAT_PING_INTERVAL_MS })).toBe('send-ping');
    // A fresh connection has never pinged (Infinity elapsed) → ping right away.
    expect(heartbeatAction({ ...base, sincePingMs: Number.POSITIVE_INFINITY })).toBe('send-ping');
  });

  it('declares the socket dead when pongs go silent past the timeout', () => {
    expect(
      heartbeatAction({ ...base, sincePingMs: 0, sincePongMs: HEARTBEAT_PONG_TIMEOUT_MS + 1 }),
    ).toBe('timeout');
  });

  it('prefers declaring death over sending yet another ping', () => {
    expect(
      heartbeatAction({
        ...base,
        sincePingMs: HEARTBEAT_PING_INTERVAL_MS,
        sincePongMs: HEARTBEAT_PONG_TIMEOUT_MS + 1,
      }),
    ).toBe('timeout');
  });

  it('honours injected thresholds', () => {
    expect(
      heartbeatAction({ ...base, sincePingMs: 30 }, { pingIntervalMs: 20, pongTimeoutMs: 100 }),
    ).toBe('send-ping');
    expect(
      heartbeatAction({ ...base, sincePongMs: 150 }, { pingIntervalMs: 20, pongTimeoutMs: 100 }),
    ).toBe('timeout');
  });
});
