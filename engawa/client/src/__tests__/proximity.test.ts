import { describe, expect, it } from 'bun:test';
import {
  distance,
  isInitiator,
  isWithinConnectRadius,
  shouldConnect,
  shouldDisconnect,
} from '../proximity';
import { CONNECT_RADIUS, DISCONNECT_RADIUS } from '../types';

describe('distance', () => {
  it('computes euclidean distance', () => {
    expect(distance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
  });
});

describe('isWithinConnectRadius', () => {
  it('is inclusive at exactly the radius', () => {
    expect(isWithinConnectRadius({ x: 0, y: 0 }, { x: CONNECT_RADIUS, y: 0 }, CONNECT_RADIUS)).toBe(
      true,
    );
  });
  it('is false just outside the radius', () => {
    expect(
      isWithinConnectRadius({ x: 0, y: 0 }, { x: CONNECT_RADIUS + 1, y: 0 }, CONNECT_RADIUS),
    ).toBe(false);
  });
});

describe('shouldConnect', () => {
  const me = { x: 0, y: 0 };
  it('connects when in range and no peer exists', () => {
    expect(shouldConnect(me, { x: 50, y: 0 }, CONNECT_RADIUS, false)).toBe(true);
  });
  it('does not connect when a peer already exists', () => {
    expect(shouldConnect(me, { x: 50, y: 0 }, CONNECT_RADIUS, true)).toBe(false);
  });
  it('does not connect when out of range', () => {
    expect(shouldConnect(me, { x: CONNECT_RADIUS + 10, y: 0 }, CONNECT_RADIUS, false)).toBe(false);
  });
});

describe('shouldDisconnect', () => {
  const me = { x: 0, y: 0 };
  it('disconnects when a peer exists and is beyond the disconnect radius', () => {
    expect(shouldDisconnect(me, { x: DISCONNECT_RADIUS + 1, y: 0 }, DISCONNECT_RADIUS, true)).toBe(
      true,
    );
  });
  it('does not disconnect at exactly the disconnect radius', () => {
    expect(shouldDisconnect(me, { x: DISCONNECT_RADIUS, y: 0 }, DISCONNECT_RADIUS, true)).toBe(
      false,
    );
  });
  it('does not disconnect when no peer exists', () => {
    expect(shouldDisconnect(me, { x: DISCONNECT_RADIUS + 100, y: 0 }, DISCONNECT_RADIUS, false)).toBe(
      false,
    );
  });

  it('hysteresis: a peer in the gap between radii is neither connected nor disconnected', () => {
    const me0 = { x: 0, y: 0 };
    const inGap = { x: (CONNECT_RADIUS + DISCONNECT_RADIUS) / 2, y: 0 };
    // Already has a peer: it stays (no new connect, no disconnect).
    expect(shouldConnect(me0, inGap, CONNECT_RADIUS, true)).toBe(false);
    expect(shouldDisconnect(me0, inGap, DISCONNECT_RADIUS, true)).toBe(false);
  });
});

describe('isInitiator', () => {
  it('the lexicographically smaller id initiates', () => {
    expect(isInitiator('aaa', 'bbb')).toBe(true);
    expect(isInitiator('bbb', 'aaa')).toBe(false);
  });
  it('elects exactly one initiator for a pair', () => {
    const a = 'user-1';
    const b = 'user-2';
    expect(isInitiator(a, b)).not.toBe(isInitiator(b, a));
  });
});
