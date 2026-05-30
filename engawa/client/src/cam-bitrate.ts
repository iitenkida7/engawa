// Speaker-aware camera send-bitrate control.
//
// engawa is a pure P2P mesh: each client sends its camera separately to every
// proximity peer, so a crowded room makes uplink/CPU grow with the peer count.
// In large groups we drop our *own* camera ceiling while we are not the current
// (or recent) speaker — non-speakers rarely need a sharp picture — which cuts
// aggregate uplink a lot without touching the no-media-through-the-server
// design. The policy math is pure here so it can be unit-tested without WebRTC;
// webrtc.ts applies it via RTCRtpSender.setParameters (seamless, no renegotiation).

// At or below this many proximity peers the throttle never kicks in: small
// groups always get the high bitrate (max quality). Above it, speakers keep the
// high rate and quiet users drop to the low one.
export const CAM_THROTTLE_MIN_PEERS = 5;

// Camera send-bitrate ceilings (bps). These mirror the encoder's *maximum*; the
// real rate still adapts down to the available bandwidth.
export const CAM_BITRATE_SPEAKING = 600_000;
export const CAM_BITRATE_QUIET = 150_000;

// After speech stops, keep the high bitrate for this long so short pauses don't
// make the picture "pulse" between sharp and soft (flapping prevention).
export const SPEAKER_HOLD_MS = 3_000;

// Pure: the camera send-bitrate ceiling for the given peer count and whether the
// local user counts as a (recent) speaker. Small groups always get the high
// rate; large groups give speakers the high rate and quiet users the low one.
export function computeCamBitrate(peerCount: number, isSpeaking: boolean): number {
  if (peerCount < CAM_THROTTLE_MIN_PEERS) return CAM_BITRATE_SPEAKING;
  return isSpeaking ? CAM_BITRATE_SPEAKING : CAM_BITRATE_QUIET;
}

// Pure: applies the speaker hold-time. The user counts as "speaking" while the
// mic is loud now OR was loud within `holdMs` of `nowMs`. A null `lastLoudAtMs`
// means they have not been loud yet (e.g. mic off, or just joined) → not
// speaking, which is the safe default (treated as a quiet peer).
export function isHeldSpeaking(
  loudNow: boolean,
  lastLoudAtMs: number | null,
  nowMs: number,
  holdMs: number = SPEAKER_HOLD_MS,
): boolean {
  if (loudNow) return true;
  if (lastLoudAtMs === null) return false;
  return nowMs - lastLoudAtMs < holdMs;
}
