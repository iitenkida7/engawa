import { describe, expect, it } from 'bun:test';
import {
  clampGain,
  gainToPercent,
  PEER_GAIN_MAX,
  PEER_SNAP_PCT,
  percentToGain,
  snapPercent,
} from '@/ui/peer-volume';

describe('clampGain', () => {
  it('keeps in-range values', () => {
    expect(clampGain(0)).toBe(0);
    expect(clampGain(0.5)).toBe(0.5);
    expect(clampGain(PEER_GAIN_MAX)).toBe(PEER_GAIN_MAX);
  });

  it('clamps out-of-range values', () => {
    expect(clampGain(-1)).toBe(0);
    expect(clampGain(99)).toBe(PEER_GAIN_MAX);
  });

  it('falls back to 1 for non-numbers', () => {
    expect(clampGain(Number.NaN)).toBe(1);
    expect(clampGain(Number.POSITIVE_INFINITY)).toBe(1);
    expect(clampGain('1.5')).toBe(1);
    expect(clampGain(null)).toBe(1);
  });
});

describe('percent conversion', () => {
  it('round-trips slider steps without float noise', () => {
    for (const p of [0, 10, 30, 70, 100, 150, 200]) {
      expect(gainToPercent(percentToGain(p))).toBe(p);
    }
    expect(gainToPercent(0.1 + 0.2)).toBe(30);
  });

  it('clamps beyond the slider range', () => {
    expect(percentToGain(500)).toBe(PEER_GAIN_MAX);
    expect(percentToGain(-20)).toBe(0);
  });
});

describe('snapPercent', () => {
  it('magnets onto the default from either side', () => {
    expect(snapPercent(100)).toBe(100);
    expect(snapPercent(100 - PEER_SNAP_PCT)).toBe(100);
    expect(snapPercent(100 + PEER_SNAP_PCT)).toBe(100);
  });

  it('leaves everything outside the magnet alone', () => {
    expect(snapPercent(100 - PEER_SNAP_PCT - 1)).toBe(100 - PEER_SNAP_PCT - 1);
    expect(snapPercent(100 + PEER_SNAP_PCT + 1)).toBe(100 + PEER_SNAP_PCT + 1);
    expect(snapPercent(0)).toBe(0);
    expect(snapPercent(200)).toBe(200);
  });

  it('rounds a fractional position to whole percent', () => {
    expect(snapPercent(149.6)).toBe(150);
  });
});
