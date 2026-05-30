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

// Screen-share is the mesh scaling wall: it must reach every one of the N-1
// peers, so the sharer encodes it N-1 times and that encode cost is what
// saturates the CPU past ~10 peers (measured: FHD VP9 ~55ms/frame; fps alone
// can't fix it — the per-frame cost must drop). We tier the screen encoding by
// peer count, all via seamless setParameters (no renegotiation):
//   - <3 peers (small): full 3 Mbps / 15fps / FHD.
//   - 3-7 peers (mid): drop the bitrate ceiling (3 Mbps × N is the biggest
//     uplink hog) but keep FHD/15fps so text stays crisp.
//   - >=8 peers (large): also drop framerate and downscale to 720p-class — this
//     cuts the per-frame encode cost (~pixels × fps) enough to keep a big
//     cluster afloat, at the cost of some text sharpness.
export const SCREEN_LARGE_MIN_PEERS = 8;

// Screen send-bitrate ceilings (bps). High is the unconstrained share quality;
// throttled keeps the per-peer × N uplink bounded once the group grows.
export const SCREEN_BITRATE_HIGH = 3_000_000;
export const SCREEN_BITRATE_THROTTLED = 1_500_000;

// Screen framerate ceilings. Screen content is mostly static, so 15fps is
// barely noticeable; large clusters drop further to claw back encode CPU.
export const SCREEN_FPS_DEFAULT = 15;
export const SCREEN_FPS_LARGE = 10;

// Longest-edge resolution caps. Encode cost ~scales with pixel count, so
// capping the longer encoded edge bounds per-frame cost. FHD tames 4K/ultrawide
// while keeping text legible; 720p-class is the large-cluster fallback.
export const SCREEN_LONG_EDGE_DEFAULT = 1920;
export const SCREEN_LONG_EDGE_LARGE = 1280;

// The full per-sender encoding ceiling for a screen-share track. Mirrors
// CamEncoding, except the resolution is expressed as a longest-edge cap
// (maxLongEdge) that webrtc.ts turns into scaleResolutionDownBy using the live
// capture size (computeScreenScale).
export type ScreenEncoding = {
  maxBitrate: number;
  maxFramerate: number;
  maxLongEdge: number;
};

// Pure: the screen-share encoding ceiling for the given peer count. See the
// tier comment above SCREEN_LARGE_MIN_PEERS.
export function computeScreenEncoding(peerCount: number): ScreenEncoding {
  const large = peerCount >= SCREEN_LARGE_MIN_PEERS;
  return {
    maxBitrate: peerCount < CAM_THROTTLE_MIN_PEERS ? SCREEN_BITRATE_HIGH : SCREEN_BITRATE_THROTTLED,
    maxFramerate: large ? SCREEN_FPS_LARGE : SCREEN_FPS_DEFAULT,
    maxLongEdge: large ? SCREEN_LONG_EDGE_LARGE : SCREEN_LONG_EDGE_DEFAULT,
  };
}

// Pure: the scaleResolutionDownBy needed to bring the longer source edge down to
// `maxLongEdge`. Returns 1 (no scaling) when the source is already within the
// cap or its size is unknown (0), and never upscales.
export function computeScreenScale(
  srcWidth: number,
  srcHeight: number,
  maxLongEdge: number,
): number {
  const longEdge = Math.max(srcWidth, srcHeight);
  if (longEdge <= 0 || maxLongEdge <= 0) return 1;
  return Math.max(1, longEdge / maxLongEdge);
}

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
