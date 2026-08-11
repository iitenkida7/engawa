import { describe, expect, it } from 'bun:test';
import { computeCamEncoding, computeScreenEncoding } from '@/rtc/cam-bitrate';
import {
  AVAIL_SIGNAL_MIN_SEND_KBPS,
  applyNetTierToCam,
  applyNetTierToScreen,
  classifySample,
  INITIAL_TIER_STATE,
  type NetTier,
  TIER_DOWNGRADE_SAMPLES,
  TIER_UPGRADE_SAMPLES,
  type TierState,
  updateTierState,
} from '@/rtc/netquality';
import type { QualitySample } from '@/rtc/rtcstats';
import {
  computeJitterTargetMs,
  JITTER_BUFFER_TARGET_MAX_MS,
  JITTER_BUFFER_TARGET_MS,
} from '@/rtc/tune';

const sample = (over: Partial<QualitySample> = {}): QualitySample => ({
  conns: 1,
  sendKbps: 100,
  recvKbps: 100,
  ...over,
});

describe('classifySample', () => {
  it('is tier 0 on a healthy link', () => {
    expect(classifySample(sample({ rttMs: 40, sendLossPct: 0.5 }))).toBe(0);
  });

  it('tiers up on loss (worst of send/recv)', () => {
    expect(classifySample(sample({ sendLossPct: 2 }))).toBe(1);
    expect(classifySample(sample({ recvLossPct: 5 }))).toBe(2);
    expect(classifySample(sample({ sendLossPct: 1, recvLossPct: 10 }))).toBe(3);
  });

  it('tiers up on RTT', () => {
    expect(classifySample(sample({ rttMs: 250 }))).toBe(1);
    expect(classifySample(sample({ rttMs: 500 }))).toBe(2);
    expect(classifySample(sample({ rttMs: 800 }))).toBe(3);
  });

  it('tiers up when the uplink estimate collapses under real send load', () => {
    const loaded = { sendKbps: AVAIL_SIGNAL_MIN_SEND_KBPS };
    expect(classifySample(sample({ ...loaded, availableOutgoingKbps: 850 }))).toBe(1);
    expect(classifySample(sample({ ...loaded, availableOutgoingKbps: 400 }))).toBe(2);
    expect(classifySample(sample({ ...loaded, availableOutgoingKbps: 200 }))).toBe(3);
    // No estimate → the signal simply doesn't contribute.
    expect(classifySample(sample(loaded))).toBe(0);
  });

  it('ignores the uplink estimate in (near) audio-only calls where BWE never probes', () => {
    // ~40kbps of audio on a gigabit link still reports a low idle estimate;
    // that must not be read as congestion.
    expect(classifySample(sample({ sendKbps: 40, availableOutgoingKbps: 300 }))).toBe(0);
    // Loss/RTT still classify on their own.
    expect(classifySample(sample({ sendKbps: 40, recvLossPct: 5 }))).toBe(2);
  });

  it('takes the worst of the signals', () => {
    expect(
      classifySample(
        sample({
          sendKbps: AVAIL_SIGNAL_MIN_SEND_KBPS,
          rttMs: 260,
          availableOutgoingKbps: 200,
        }),
      ),
    ).toBe(3);
  });
});

describe('updateTierState', () => {
  const runSamples = (state: TierState, tiers: NetTier[]): TierState => {
    let s = state;
    for (const t of tiers) s = updateTierState(s, t);
    return s;
  };

  it('downgrades only after consecutive worse samples', () => {
    let s = INITIAL_TIER_STATE;
    s = updateTierState(s, 2);
    expect(s.tier).toBe(0); // one bad sample is noise
    s = updateTierState(s, 2);
    expect(s.tier).toBe(2); // two in a row is a trend
  });

  it('a good sample in between resets the downgrade streak', () => {
    const s = runSamples(INITIAL_TIER_STATE, [2, 0, 2]);
    expect(s.tier).toBe(0);
  });

  it('upgrades one step only after a long streak of better samples', () => {
    let s: TierState = { tier: 3, worse: 0, better: 0 };
    s = runSamples(s, Array(TIER_UPGRADE_SAMPLES - 1).fill(0) as NetTier[]);
    expect(s.tier).toBe(3);
    s = updateTierState(s, 0);
    expect(s.tier).toBe(2); // one step, not straight to 0
  });

  it('needs TIER_DOWNGRADE_SAMPLES to move down', () => {
    const s = runSamples(INITIAL_TIER_STATE, Array(TIER_DOWNGRADE_SAMPLES).fill(3) as NetTier[]);
    expect(s.tier).toBe(3);
  });
});

describe('applyNetTierToCam / applyNetTierToScreen', () => {
  const camBase = computeCamEncoding(0, true); // small-group high quality
  const screenBase = computeScreenEncoding(0);

  it('tier 0 leaves the base ceilings untouched', () => {
    expect(applyNetTierToCam(camBase, 0)).toEqual(camBase);
    expect(applyNetTierToScreen(screenBase, 0)).toEqual(screenBase);
  });

  it('each tier only ever tightens the ceilings', () => {
    let prevCam = camBase;
    let prevScreen = screenBase;
    for (const tier of [1, 2, 3] as const) {
      const cam = applyNetTierToCam(camBase, tier);
      expect(cam.maxBitrate).toBeLessThanOrEqual(prevCam.maxBitrate);
      expect(cam.maxFramerate).toBeLessThanOrEqual(prevCam.maxFramerate);
      expect(cam.scaleResolutionDownBy).toBeGreaterThanOrEqual(prevCam.scaleResolutionDownBy);
      prevCam = cam;
      const screen = applyNetTierToScreen(screenBase, tier);
      expect(screen.maxBitrate).toBeLessThanOrEqual(prevScreen.maxBitrate);
      expect(screen.maxFramerate).toBeLessThanOrEqual(prevScreen.maxFramerate);
      expect(screen.maxLongEdge).toBeLessThanOrEqual(prevScreen.maxLongEdge);
      prevScreen = screen;
    }
  });

  it('never raises a ceiling the group policy already lowered', () => {
    const quiet = computeCamEncoding(5, false); // throttled: 150k / 15fps / scale 2
    const tier2 = applyNetTierToCam(quiet, 2);
    expect(tier2.maxBitrate).toBeLessThanOrEqual(quiet.maxBitrate);
    expect(tier2.maxFramerate).toBeLessThanOrEqual(quiet.maxFramerate);
    expect(tier2.scaleResolutionDownBy).toBeGreaterThanOrEqual(quiet.scaleResolutionDownBy);
  });
});

describe('computeJitterTargetMs', () => {
  it('keeps the low-latency floor on a calm link or before stats warm up', () => {
    expect(computeJitterTargetMs(undefined)).toBe(JITTER_BUFFER_TARGET_MS);
    expect(computeJitterTargetMs(10)).toBe(JITTER_BUFFER_TARGET_MS);
    expect(computeJitterTargetMs(39)).toBe(JITTER_BUFFER_TARGET_MS);
  });

  it('widens with measured jitter up to the ceiling', () => {
    expect(computeJitterTargetMs(50)).toBe(150);
    expect(computeJitterTargetMs(100)).toBe(220);
    expect(computeJitterTargetMs(200)).toBe(JITTER_BUFFER_TARGET_MAX_MS);
    expect(computeJitterTargetMs(10_000)).toBe(JITTER_BUFFER_TARGET_MAX_MS);
  });
});
