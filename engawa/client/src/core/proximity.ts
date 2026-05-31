// Pure helpers for WebRTC mesh peers, kept out of the app for unit-testing.
//
// Call membership (who meshes with whom, and the connect/disconnect hysteresis)
// is now decided server-side by computeProximityGroups and delivered via
// group-update; the client just opens a peer to every listed member. The old
// pairwise connect/disconnect/zone helpers that drove the per-frame proximity
// loop were removed with that loop — only initiator election remains client-side.

export type Point = { x: number; y: number };

/**
 * Deterministic initiator election: the lexicographically smaller id starts
 * the offer so both peers agree on exactly one initiator.
 */
export function isInitiator(myId: string, otherId: string): boolean {
  return myId < otherId;
}
