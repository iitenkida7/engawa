// Pure geometry/decision helpers for WebRTC proximity connections.
// Extracted from game.ts so the connect/disconnect rules can be unit-tested
// without a running game loop. Behaviour must match the original inline logic.

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
 * Decide whether `me` should open a new peer connection to `other`.
 * Mirrors the game-loop rule: connect when no peer exists yet and the other
 * player is inside `connectRadius`.
 */
export function shouldConnect(
  me: Point,
  other: Point,
  connectRadius: number,
  hasPeer: boolean,
): boolean {
  return !hasPeer && isWithinConnectRadius(me, other, connectRadius);
}

/**
 * Decide whether `me` should tear down an existing peer to `other`.
 * Mirrors the game-loop rule: disconnect when a peer exists and the other
 * player has drifted beyond `disconnectRadius`. The hysteresis gap between
 * connect/disconnect radii prevents flapping at the boundary.
 */
export function shouldDisconnect(
  me: Point,
  other: Point,
  disconnectRadius: number,
  hasPeer: boolean,
): boolean {
  return hasPeer && distance(me, other) > disconnectRadius;
}

/**
 * Deterministic initiator election: the lexicographically smaller id starts
 * the offer so both peers agree on exactly one initiator.
 */
export function isInitiator(myId: string, otherId: string): boolean {
  return myId < otherId;
}
