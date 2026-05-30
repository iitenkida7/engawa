// Speaker-aware camera + peer-count-aware screen send policy.
//
// engawa is a pure P2P mesh: each client sends its camera/screen separately to
// every proximity peer, so a crowded room makes uplink/CPU grow with the peer
// count. To keep the mesh within its limits without touching the
// no-media-through-the-server design we throttle our *own* send streams in big
// groups:
//   - camera: while we are not the current (or recent) speaker we drop the
//     bitrate AND the framerate/resolution — a quiet thumbnail rarely needs a
//     sharp, smooth picture, and lowering fps/resolution cuts encode CPU too.
//   - screen: a single 3 Mbps share to N peers is the biggest uplink hog
//     (3 Mbps × N), so in big groups we drop the ceiling (peer-count only — a
//     screen share has no "speaker" notion).
// The policy math is pure here so it can be unit-tested without WebRTC;
// webrtc.ts applies it via RTCRtpSender.setParameters (seamless, no renegotiation).

// At or below this many proximity peers the throttle never kicks in: small
// groups always get the high quality. At this count or above, camera speakers
// keep the high rate (quiet users drop) and screen shares drop unconditionally.
export const CAM_THROTTLE_MIN_PEERS = 3;

// Camera send-bitrate ceilings (bps). These mirror the encoder's *maximum*; the
// real rate still adapts down to the available bandwidth.
export const CAM_BITRATE_SPEAKING = 600_000;
export const CAM_BITRATE_QUIET = 150_000;

// Camera framerate / resolution-downscale ceilings. The quiet (throttled) state
// halves the framerate and each spatial dimension; the capture itself stays at
// its full rate so a speaker gets the smooth/sharp picture immediately.
export const CAM_FPS_SPEAKING = 30;
export const CAM_FPS_QUIET = 15;
export const CAM_SCALE_SPEAKING = 1;
export const CAM_SCALE_QUIET = 2;

// Screen send-bitrate ceilings (bps). High is the unconstrained share quality;
// throttled is used once the group passes CAM_THROTTLE_MIN_PEERS so the
// per-peer × N uplink stays bounded while slides/text remain legible.
export const SCREEN_BITRATE_HIGH = 3_000_000;
export const SCREEN_BITRATE_THROTTLED = 1_500_000;

// After speech stops, keep the high bitrate for this long so short pauses don't
// make the picture "pulse" between sharp and soft (flapping prevention).
export const SPEAKER_HOLD_MS = 3_000;

// The full per-sender encoding ceiling for a camera track.
export type CamEncoding = {
  maxBitrate: number;
  maxFramerate: number;
  scaleResolutionDownBy: number;
};

// Pure: the camera encoding ceiling for the given peer count and whether the
// local user counts as a (recent) speaker. Small groups (or speakers in big
// groups) get the high bitrate/fps/full resolution; quiet users in big groups
// get the throttled bitrate, half framerate and half resolution.
export function computeCamEncoding(peerCount: number, isSpeaking: boolean): CamEncoding {
  const high = peerCount < CAM_THROTTLE_MIN_PEERS || isSpeaking;
  return high
    ? {
        maxBitrate: CAM_BITRATE_SPEAKING,
        maxFramerate: CAM_FPS_SPEAKING,
        scaleResolutionDownBy: CAM_SCALE_SPEAKING,
      }
    : {
        maxBitrate: CAM_BITRATE_QUIET,
        maxFramerate: CAM_FPS_QUIET,
        scaleResolutionDownBy: CAM_SCALE_QUIET,
      };
}

// Pure: the screen-share send-bitrate ceiling for the given peer count. Small
// groups keep the full quality; big groups drop to the throttled ceiling so the
// 3 Mbps × N uplink does not blow up the sharer's connection.
export function computeScreenBitrate(peerCount: number): number {
  return peerCount < CAM_THROTTLE_MIN_PEERS ? SCREEN_BITRATE_HIGH : SCREEN_BITRATE_THROTTLED;
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
