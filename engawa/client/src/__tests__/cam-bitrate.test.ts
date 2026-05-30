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
  SPEAKER_HOLD_MS,
  computeCamEncoding,
  computeScreenBitrate,
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

describe('computeScreenBitrate', () => {
  it('keeps the full rate in small groups', () => {
    for (let n = 0; n < CAM_THROTTLE_MIN_PEERS; n++) {
      expect(computeScreenBitrate(n)).toBe(SCREEN_BITRATE_HIGH);
    }
  });

  it('throttles once the group is large (peer-count only, no speaker notion)', () => {
    expect(computeScreenBitrate(CAM_THROTTLE_MIN_PEERS)).toBe(SCREEN_BITRATE_THROTTLED);
    expect(computeScreenBitrate(19)).toBe(SCREEN_BITRATE_THROTTLED);
  });

  it('the throttled rate is meaningfully lower than the high rate', () => {
    expect(SCREEN_BITRATE_THROTTLED).toBeLessThan(SCREEN_BITRATE_HIGH);
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
