import { describe, expect, it } from 'bun:test';
import {
  CAM_BITRATE_QUIET,
  CAM_BITRATE_SPEAKING,
  CAM_FPS_QUIET,
  CAM_FPS_SPEAKING,
  CAM_SCALE_QUIET,
  CAM_SCALE_SPEAKING,
  CAM_THROTTLE_MIN_PEERS,
  SCREEN_BITRATE_HIGH,
  SCREEN_BITRATE_THROTTLED,
  SCREEN_FPS_DEFAULT,
  SCREEN_FPS_LARGE,
  SCREEN_LARGE_MIN_PEERS,
  SCREEN_LONG_EDGE_DEFAULT,
  SCREEN_LONG_EDGE_LARGE,
  SPEAKER_HOLD_MS,
  computeCamEncoding,
  computeScreenEncoding,
  computeScreenScale,
  isHeldSpeaking,
} from '../cam-bitrate';

describe('computeCamEncoding', () => {
  const HIGH = {
    maxBitrate: CAM_BITRATE_SPEAKING,
    maxFramerate: CAM_FPS_SPEAKING,
    scaleResolutionDownBy: CAM_SCALE_SPEAKING,
  };
  const QUIET = {
    maxBitrate: CAM_BITRATE_QUIET,
    maxFramerate: CAM_FPS_QUIET,
    scaleResolutionDownBy: CAM_SCALE_QUIET,
  };

  it('keeps the high encoding in small groups regardless of speaking', () => {
    // At or below the threshold the throttle never kicks in.
    for (let n = 0; n < CAM_THROTTLE_MIN_PEERS; n++) {
      expect(computeCamEncoding(n, false)).toEqual(HIGH);
      expect(computeCamEncoding(n, true)).toEqual(HIGH);
    }
  });

  it('throttles non-speakers (bitrate + fps + resolution) once the group is large', () => {
    expect(computeCamEncoding(CAM_THROTTLE_MIN_PEERS, false)).toEqual(QUIET);
    expect(computeCamEncoding(19, false)).toEqual(QUIET);
  });

  it('keeps speakers at the high encoding even in a large group', () => {
    expect(computeCamEncoding(CAM_THROTTLE_MIN_PEERS, true)).toEqual(HIGH);
    expect(computeCamEncoding(19, true)).toEqual(HIGH);
  });

  it('the quiet encoding is meaningfully lighter than the speaking one', () => {
    expect(CAM_BITRATE_QUIET).toBeLessThan(CAM_BITRATE_SPEAKING);
    expect(CAM_FPS_QUIET).toBeLessThan(CAM_FPS_SPEAKING);
    expect(CAM_SCALE_QUIET).toBeGreaterThan(CAM_SCALE_SPEAKING);
  });
});

describe('computeScreenEncoding', () => {
  it('keeps full bitrate / fps / FHD in small groups', () => {
    for (let n = 0; n < CAM_THROTTLE_MIN_PEERS; n++) {
      expect(computeScreenEncoding(n)).toEqual({
        maxBitrate: SCREEN_BITRATE_HIGH,
        maxFramerate: SCREEN_FPS_DEFAULT,
        maxLongEdge: SCREEN_LONG_EDGE_DEFAULT,
      });
    }
  });

  it('throttles only the bitrate in mid-size groups (keeps FHD/full fps for text)', () => {
    for (let n = CAM_THROTTLE_MIN_PEERS; n < SCREEN_LARGE_MIN_PEERS; n++) {
      expect(computeScreenEncoding(n)).toEqual({
        maxBitrate: SCREEN_BITRATE_THROTTLED,
        maxFramerate: SCREEN_FPS_DEFAULT,
        maxLongEdge: SCREEN_LONG_EDGE_DEFAULT,
      });
    }
  });

  it('also drops fps and resolution in large clusters (per-frame encode cut)', () => {
    expect(computeScreenEncoding(SCREEN_LARGE_MIN_PEERS)).toEqual({
      maxBitrate: SCREEN_BITRATE_THROTTLED,
      maxFramerate: SCREEN_FPS_LARGE,
      maxLongEdge: SCREEN_LONG_EDGE_LARGE,
    });
    expect(computeScreenEncoding(20).maxLongEdge).toBe(SCREEN_LONG_EDGE_LARGE);
  });

  it('the large-cluster ceilings are strictly lower (more aggressive)', () => {
    expect(SCREEN_BITRATE_THROTTLED).toBeLessThan(SCREEN_BITRATE_HIGH);
    expect(SCREEN_FPS_LARGE).toBeLessThan(SCREEN_FPS_DEFAULT);
    expect(SCREEN_LONG_EDGE_LARGE).toBeLessThan(SCREEN_LONG_EDGE_DEFAULT);
  });
});

describe('computeScreenScale', () => {
  it('does not scale a source already within the cap', () => {
    // 16:9 1080p monitor: longest edge 1920 == FHD cap → no downscale.
    expect(computeScreenScale(1920, 1080, SCREEN_LONG_EDGE_DEFAULT)).toBe(1);
    // 720p is well within the FHD cap.
    expect(computeScreenScale(1280, 720, SCREEN_LONG_EDGE_DEFAULT)).toBe(1);
  });

  it('scales an ultrawide source down to the FHD long edge', () => {
    // 3420 wide → 3420 / 1920 ≈ 1.781 (encoded ~1920×649).
    expect(computeScreenScale(3420, 1156, SCREEN_LONG_EDGE_DEFAULT)).toBeCloseTo(
      3420 / SCREEN_LONG_EDGE_DEFAULT,
      5,
    );
  });

  it('scales a 4K source to exactly half against the FHD cap', () => {
    expect(computeScreenScale(3840, 2160, SCREEN_LONG_EDGE_DEFAULT)).toBe(2);
  });

  it('uses the longer edge regardless of orientation', () => {
    expect(computeScreenScale(1156, 3420, SCREEN_LONG_EDGE_DEFAULT)).toBeCloseTo(
      3420 / SCREEN_LONG_EDGE_DEFAULT,
      5,
    );
  });

  it('never upscales and is safe for an unknown (0) source size', () => {
    expect(computeScreenScale(640, 480, SCREEN_LONG_EDGE_DEFAULT)).toBe(1);
    expect(computeScreenScale(0, 0, SCREEN_LONG_EDGE_DEFAULT)).toBe(1);
    expect(computeScreenScale(0, 1080, SCREEN_LONG_EDGE_DEFAULT)).toBe(1);
  });

  it('downscales harder against the 720p (large-cluster) cap', () => {
    // 1080p monitor against the 720p cap scales by 1.5 → 1280×720.
    expect(computeScreenScale(1920, 1080, SCREEN_LONG_EDGE_LARGE)).toBeCloseTo(1.5, 5);
    // An FHD-capped share is already small; the 720p cap still bites.
    expect(computeScreenScale(1920, 649, SCREEN_LONG_EDGE_LARGE)).toBeCloseTo(1.5, 5);
  });
});

describe('isHeldSpeaking', () => {
  it('is true whenever the mic is loud now', () => {
    expect(isHeldSpeaking(true, null, 1000)).toBe(true);
    expect(isHeldSpeaking(true, 0, 1_000_000)).toBe(true);
  });

  it('is false when never loud yet (e.g. mic off / just joined)', () => {
    // null lastLoudAtMs is the safe default: counts as a quiet peer.
    expect(isHeldSpeaking(false, null, 1000)).toBe(false);
  });

  it('holds the speaking state for the hold window after speech stops', () => {
    const lastLoud = 1000;
    // Just after stopping: still within the hold → speaking.
    expect(isHeldSpeaking(false, lastLoud, lastLoud + 1)).toBe(true);
    expect(isHeldSpeaking(false, lastLoud, lastLoud + SPEAKER_HOLD_MS - 1)).toBe(true);
  });

  it('drops the speaking state once the hold window elapses', () => {
    const lastLoud = 1000;
    // Exactly at the boundary is no longer held (strict less-than).
    expect(isHeldSpeaking(false, lastLoud, lastLoud + SPEAKER_HOLD_MS)).toBe(false);
    expect(isHeldSpeaking(false, lastLoud, lastLoud + SPEAKER_HOLD_MS + 5000)).toBe(false);
  });

  it('respects a custom hold duration', () => {
    expect(isHeldSpeaking(false, 0, 500, 1000)).toBe(true);
    expect(isHeldSpeaking(false, 0, 1500, 1000)).toBe(false);
  });
});
