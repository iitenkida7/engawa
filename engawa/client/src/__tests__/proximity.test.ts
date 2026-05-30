import { describe, expect, it } from 'bun:test';
import {
  distance,
  inCallRange,
  isInitiator,
  isWithinConnectRadius,
  shouldConnect,
  shouldDisconnect,
  zoneConnection,
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

describe('zoneConnection (meeting-room isolation)', () => {
  it('returns null when both are outside any room (fall back to proximity)', () => {
    expect(zoneConnection(null, null)).toBe(null);
  });
  it('connects two players in the same room', () => {
    expect(zoneConnection('meeting-1', 'meeting-1')).toBe(true);
  });
  it('does not connect players in different rooms', () => {
    expect(zoneConnection('meeting-1', 'meeting-2')).toBe(false);
  });
  it('does not connect across the room boundary (inside vs outside)', () => {
    expect(zoneConnection('meeting-1', null)).toBe(false);
    expect(zoneConnection(null, 'meeting-1')).toBe(false);
  });
});

describe('inCallRange with zones', () => {
  const me = { x: 0, y: 0 };
  const farAway = { x: 99999, y: 99999 };
  it('same room: in call regardless of distance', () => {
    expect(inCallRange(me, farAway, CONNECT_RADIUS, 'meeting-1', 'meeting-1')).toBe(true);
  });
  it('inside vs outside: never in call even when adjacent', () => {
    expect(inCallRange(me, { x: 1, y: 0 }, CONNECT_RADIUS, 'meeting-1', null)).toBe(false);
  });
  it('both outside: falls back to the radius', () => {
    expect(inCallRange(me, { x: 50, y: 0 }, CONNECT_RADIUS, null, null)).toBe(true);
    expect(inCallRange(me, { x: CONNECT_RADIUS + 1, y: 0 }, CONNECT_RADIUS, null, null)).toBe(false);
  });
});

describe('shouldConnect / shouldDisconnect with zones', () => {
  const me = { x: 0, y: 0 };
  const farAway = { x: 99999, y: 99999 };

  it('connects everyone in the same room regardless of distance', () => {
    expect(shouldConnect(me, farAway, CONNECT_RADIUS, false, 'meeting-1', 'meeting-1')).toBe(true);
  });
  it('does not connect a far-but-same-room peer that already has a peer', () => {
    expect(shouldConnect(me, farAway, CONNECT_RADIUS, true, 'meeting-1', 'meeting-1')).toBe(false);
  });
  it('does not leak: inside vs outside never connects even when adjacent', () => {
    expect(shouldConnect(me, { x: 1, y: 0 }, CONNECT_RADIUS, false, 'meeting-1', null)).toBe(false);
  });
  it('does not connect across different rooms', () => {
    expect(shouldConnect(me, farAway, CONNECT_RADIUS, false, 'meeting-1', 'meeting-2')).toBe(false);
  });

  it('immediately disconnects when one player leaves the room (no hysteresis)', () => {
    // Was connected in the same room; the other steps just outside the door.
    expect(shouldDisconnect(me, { x: 1, y: 0 }, DISCONNECT_RADIUS, true, 'meeting-1', null)).toBe(
      true,
    );
  });
  it('keeps same-room peers connected no matter the distance', () => {
    expect(shouldDisconnect(me, farAway, DISCONNECT_RADIUS, true, 'meeting-1', 'meeting-1')).toBe(
      false,
    );
  });
  it('disconnects when both are outside and beyond the disconnect radius', () => {
    expect(shouldDisconnect(me, farAway, DISCONNECT_RADIUS, true, null, null)).toBe(true);
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
