// Media left running with nobody to talk to (#426). On the open floor there is
// no door to walk out of, so the zone-exit cut (core/zone-media.ts) never
// fires: a mic left hot at an empty desk keeps broadcasting the room — and the
// muttering in it — to whoever wanders into range next. After a minute alone we
// cut mic, camera and screen share.
//
// Only the open floor is covered. Rooms, 1-on-1s, booths, the hanare, the
// lounges and the team areas are places people sit down IN order to be
// available, where sitting alone with the camera on is waiting, not an
// accident — callZoneAt() already reports exactly those as a non-null id.
//
// Kept as pure logic so the timer is unit-testable without a game loop,
// matching the "extract pure logic into a module" pattern (core/zone-media.ts).

// How long to stay alone, on the open floor, with media on before it is cut.
export const ALONE_MEDIA_OFF_MS = 60_000;

// Whether the local user is in the situation the timer watches for. `peerCount`
// is the server-decided call group (minus ourselves), not the proximity radius,
// so it matches who can actually hear us.
//
// Recording and transcription hold the timer off: both were started
// deliberately and both are routinely done alone (recording a walkthrough,
// dictating a memo), so cutting the mic underneath them would break the very
// thing the user is in the middle of.
export function isAloneWithMediaOn(input: {
  anyMediaOn: boolean;
  callZoneId: string | null;
  peerCount: number;
  recording: boolean;
  transcribing: boolean;
}): boolean {
  return (
    input.anyMediaOn &&
    input.callZoneId === null &&
    input.peerCount === 0 &&
    !input.recording &&
    !input.transcribing
  );
}

export type AloneMediaStep = {
  // Timestamp the current alone-with-media stretch started, or null when the
  // timer is not running. Feed it back in on the next frame.
  since: number | null;
  // True on the single frame the cut is due.
  disable: boolean;
};

// Advance the timer by one frame. Anything that ends the situation — someone
// joining the call, stepping into a zone, starting a recording, turning the
// media off by hand — resets it to zero, so the minute always means a full
// uninterrupted minute alone.
//
// `since` is cleared on the frame that fires, and the cut itself turns the
// media off, so `alone` goes false right after: one cut per stretch, never a
// repeat every frame.
export function stepAloneMedia(since: number | null, alone: boolean, now: number): AloneMediaStep {
  if (!alone) return { since: null, disable: false };
  const start = since ?? now;
  if (now - start < ALONE_MEDIA_OFF_MS) return { since: start, disable: false };
  return { since: null, disable: true };
}
