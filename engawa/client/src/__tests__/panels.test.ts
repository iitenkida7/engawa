import { describe, expect, it } from 'bun:test';
import { computePanelPreset } from '../panels';

// A roomy reference viewport so the aspect clamps don't kick in unless intended.
const VW = 1000;
const VH = 800;
const ASPECT = 16 / 9;

describe('computePanelPreset — pip', () => {
  it('aspect-locked: fixed 180px width pinned to the top-right, height unset', () => {
    const g = computePanelPreset('pip', true, VW, VH, ASPECT);
    // left = vw - margin(12) - width(180)
    expect(g).toEqual({ left: 808, top: 12, width: 180, height: null });
  });

  it('non-locked: fixed 420x280 in the bottom-left above the toolbar', () => {
    const g = computePanelPreset('pip', false, VW, VH, ASPECT);
    // top = max(12, vh - bottomReserved(80) - height(280)) = max(12, 440)
    expect(g).toEqual({ left: 12, top: 440, width: 420, height: 280 });
  });

  it('non-locked: clamps top to the margin when the viewport is short', () => {
    const g = computePanelPreset('pip', false, VW, 300, ASPECT);
    // vh - 80 - 280 = -60 → clamped to margin 12
    expect(g.top).toBe(12);
  });
});

describe('computePanelPreset — side', () => {
  it('non-locked: ~40% width pinned to the right, full usable height', () => {
    const g = computePanelPreset('side', false, VW, VH, ASPECT);
    // target = max(300, round(1000*0.4)) = 400; maxH = 800-12-80 = 708
    expect(g).toEqual({ left: 588, top: 12, width: 400, height: 708 });
  });

  it('aspect-locked: width is the lesser of the 40% target and aspect*maxH', () => {
    // Short viewport so aspect*maxH < target, exercising the clamp.
    // maxH = 300-12-80 = 208; round(208 * 16/9) = 370 < target 400
    const g = computePanelPreset('side', true, VW, 300, ASPECT);
    expect(g.width).toBe(370);
    expect(g.height).toBeNull();
    expect(g.left).toBe(VW - 12 - 370);
  });
});

describe('computePanelPreset — full', () => {
  it('non-locked: spans the viewport minus margins', () => {
    const g = computePanelPreset('full', false, VW, VH, ASPECT);
    // width = vw - 2*margin = 976; height = maxH = 708
    expect(g).toEqual({ left: 12, top: 12, width: 976, height: 708 });
  });

  it('aspect-locked: width capped by aspect*maxH, height unset', () => {
    // maxH = 300-12-80 = 208; round(208 * 16/9) = 370 < (vw - 24) = 976
    const g = computePanelPreset('full', true, VW, 300, ASPECT);
    expect(g.width).toBe(370);
    expect(g.height).toBeNull();
    expect(g.left).toBe(12);
  });
});
