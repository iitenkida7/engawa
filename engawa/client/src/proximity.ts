// Pure geometry/decision helpers for WebRTC proximity connections.
// Extracted from the app's game loop so the connect/disconnect rules can be
// unit-tested in isolation. Behaviour must match the original inline logic.

export type Point = { x: number; y: number };

/** Euclidean distance between two points. */
export function distance(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/** True when `other` is within `radius` pixels of `a` (inclusive). */
export function isWithinConnectRadius(a: Point, other: Point, radius: number): boolean {
  return distance(a, other) <= radius;
}

/**
 * Meeting-room isolation rule. When either player is inside a meeting room the
 * call is decided purely by zone membership — connected iff both are in the
 * *same* room — so audio/video neither leaks out of a room nor in from outside.
 * Returns null when both are outside every room, signalling the caller to fall
 * back to proximity (radius) rules.
 *
 * A zone id is the `Zone.id` of the room a player stands in, or null when out.
 */
export function zoneConnection(
  myZoneId: string | null,
  otherZoneId: string | null,
): boolean | null {
  if (myZoneId !== null || otherZoneId !== null) {
    return myZoneId !== null && myZoneId === otherZoneId;
  }
  return null;
}

/**
 * True when `me` and `other` should currently be in a call — the single source
 * of truth shared by connect/disconnect and the proximity chime/ring. Inside a
 * room, zone membership decides; outside, the given radius decides.
 */
export function inCallRange(
  me: Point,
  other: Point,
  radius: number,
  myZoneId: string | null = null,
  otherZoneId: string | null = null,
): boolean {
  const zone = zoneConnection(myZoneId, otherZoneId);
  if (zone !== null) return zone;
  return isWithinConnectRadius(me, other, radius);
}

/**
 * Decide whether `me` should open a new peer connection to `other`.
 * Connect when no peer exists yet and the two should be in a call: same meeting
 * room, or — when both are outside any room — inside `connectRadius`.
 */
export function shouldConnect(
  me: Point,
  other: Point,
  connectRadius: number,
  hasPeer: boolean,
  myZoneId: string | null = null,
  otherZoneId: string | null = null,
): boolean {
  return !hasPeer && inCallRange(me, other, connectRadius, myZoneId, otherZoneId);
}

/**
 * Decide whether `me` should tear down an existing peer to `other`.
 * Disconnect when a peer exists but the two should no longer be in a call.
 * Outside any room the `disconnectRadius` hysteresis gap prevents flapping at
 * the boundary; entering/leaving a room switches immediately (no hysteresis).
 */
export function shouldDisconnect(
  me: Point,
  other: Point,
  disconnectRadius: number,
  hasPeer: boolean,
  myZoneId: string | null = null,
  otherZoneId: string | null = null,
): boolean {
  if (!hasPeer) return false;
  const zone = zoneConnection(myZoneId, otherZoneId);
  if (zone !== null) return !zone;
  return distance(me, other) > disconnectRadius;
}

/**
 * Deterministic initiator election: the lexicographically smaller id starts
 * the offer so both peers agree on exactly one initiator.
 */
export function isInitiator(myId: string, otherId: string): boolean {
  return myId < otherId;
}
