import { describe, expect, it } from 'bun:test';
import {
  DEFAULT_FRAME_DT,
  MAX_FRAME_DT,
  computeFrameDt,
  shouldConfirmUnload,
} from '../lifecycle';

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
