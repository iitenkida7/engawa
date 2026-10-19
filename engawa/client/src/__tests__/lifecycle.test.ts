import { describe, expect, it } from 'bun:test';
import {
  computeFrameDt,
  DEFAULT_FRAME_DT,
  MAX_FOREGROUND_FPS,
  MAX_FRAME_DT,
  shouldConfirmUnload,
  shouldRunFrame,
} from '@/core/lifecycle';

describe('computeFrameDt', () => {
  it('uses the nominal 60fps step on the first frame (no previous timestamp)', () => {
    expect(computeFrameDt(0, 1000)).toBe(DEFAULT_FRAME_DT);
  });

  it('returns the elapsed seconds between two frames', () => {
    expect(computeFrameDt(1000, 1016)).toBeCloseTo(0.016, 5);
  });

  it('clamps a long gap (hidden tab / paused debugger) to MAX_FRAME_DT', () => {
    expect(computeFrameDt(1000, 1000 + 5000)).toBe(MAX_FRAME_DT);
  });
});

describe('shouldConfirmUnload', () => {
  it('confirms a close once joined', () => {
    expect(shouldConfirmUnload(true)).toBe(true);
  });

  it('does not confirm before joining', () => {
    expect(shouldConfirmUnload(false)).toBe(false);
  });
});

describe('shouldRunFrame', () => {
  const interval = 1000 / MAX_FOREGROUND_FPS;

  it('always runs the first frame', () => {
    expect(shouldRunFrame(0, 1000)).toBe(true);
  });

  it('runs every frame of a 60Hz display, even a little early', () => {
    expect(shouldRunFrame(1000, 1000 + interval)).toBe(true);
    expect(shouldRunFrame(1000, 1000 + interval - 1)).toBe(true);
  });

  it('skips every other frame of a 120Hz display', () => {
    const frame120 = 1000 / 120;
    expect(shouldRunFrame(1000, 1000 + frame120)).toBe(false);
    expect(shouldRunFrame(1000, 1000 + 2 * frame120)).toBe(true);
  });
});
