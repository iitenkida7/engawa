// Leaving a zone cuts your media (#306). Rooms, 1-on-1s, booths, the hanare and
// the outdoor lounges are all places you deliberately walk INTO, so walking back
// out is the clearest "I'm done here" signal there is — and a camera still
// broadcasting from the hallway is the accident worth preventing.
//
// Kept as a pure predicate so the rule is unit-testable without a game loop,
// matching the "extract pure logic into a module" pattern (core/lifecycle.ts).

// Whether stepping from `prevZoneId` to `nextZoneId` should turn the local mic,
// camera and screen share off.
//
// Only the zone → open-floor transition counts. Walking between two zones never
// happens without crossing the hallway (rooms are walled), and re-entering must
// not undo anything: the cut is deliberately one-way, so a user pacing across a
// doorway loses their media once rather than flapping it on and off.
//
// `anyMediaOn` keeps a silent exit silent — with everything already off there is
// nothing to cut and nothing worth a toast.
export function shouldDisableOnZoneExit(
  prevZoneId: string | null,
  nextZoneId: string | null,
  anyMediaOn: boolean,
): boolean {
  return anyMediaOn && prevZoneId !== null && nextZoneId === null;
}
