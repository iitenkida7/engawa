import { describe, expect, it } from 'bun:test';
import {
  clampGain,
  gainToPercent,
  PEER_GAIN_MAX,
  parseVolumeMap,
  percentToGain,
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

describe('parseVolumeMap', () => {
  it('returns empty for missing or corrupt input', () => {
    expect(parseVolumeMap(null)).toEqual({});
    expect(parseVolumeMap('')).toEqual({});
    expect(parseVolumeMap('not json')).toEqual({});
    expect(parseVolumeMap('[1,2]')).toEqual({});
    expect(parseVolumeMap('"x"')).toEqual({});
  });

  it('keeps valid entries and clamps them', () => {
    expect(parseVolumeMap('{"Alice":1.5,"Bob":0.3,"Eve":9}')).toEqual({
      Alice: 1.5,
      Bob: 0.3,
      Eve: PEER_GAIN_MAX,
    });
  });

  it('drops non-numeric and default-valued entries', () => {
    expect(parseVolumeMap('{"A":"loud","B":1,"C":null,"D":0.5}')).toEqual({ D: 0.5 });
  });
});
