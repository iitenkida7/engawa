import { describe, expect, it } from 'bun:test';
import {
  CAM_BITRATE_QUIET,
  CAM_BITRATE_SPEAKING,
  CAM_THROTTLE_MIN_PEERS,
  SPEAKER_HOLD_MS,
  computeCamBitrate,
  isHeldSpeaking,
} from '../cam-bitrate';

describe('computeCamBitrate', () => {
  it('keeps the high rate in small groups regardless of speaking', () => {
    // At or below the threshold the throttle never kicks in.
    for (let n = 0; n < CAM_THROTTLE_MIN_PEERS; n++) {
      expect(computeCamBitrate(n, false)).toBe(CAM_BITRATE_SPEAKING);
      expect(computeCamBitrate(n, true)).toBe(CAM_BITRATE_SPEAKING);
    }
  });

  it('throttles non-speakers once the group is large', () => {
    expect(computeCamBitrate(CAM_THROTTLE_MIN_PEERS, false)).toBe(CAM_BITRATE_QUIET);
    expect(computeCamBitrate(19, false)).toBe(CAM_BITRATE_QUIET);
  });

  it('keeps speakers at the high rate even in a large group', () => {
    expect(computeCamBitrate(CAM_THROTTLE_MIN_PEERS, true)).toBe(CAM_BITRATE_SPEAKING);
    expect(computeCamBitrate(19, true)).toBe(CAM_BITRATE_SPEAKING);
  });

  it('the quiet rate is meaningfully lower than the speaking rate', () => {
    expect(CAM_BITRATE_QUIET).toBeLessThan(CAM_BITRATE_SPEAKING);
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
