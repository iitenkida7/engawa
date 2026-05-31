import { beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { PlayerState } from '@/world/player';
import { EXTRAP_MAX_MS } from '@/core/types';

function makePlayer(x = 0, y = 0, id = 'u1') {
  return new PlayerState({ userId: id, name: 'Alice Smith', x, y }, false);
}

describe('PlayerState.interpolate', () => {
  beforeEach(() => {
    spyOn(performance, 'now').mockReturnValue(1000);
  });

  it('moves the rendered position toward the target', () => {
    const p = makePlayer(0, 0);
    // Target far from current render position, no velocity.
    p.setTarget(100, 0, 0, 0);
    p.interpolate(0.016);
    expect(p.x).toBeGreaterThan(0);
    expect(p.x).toBeLessThan(100);
    expect(p.y).toBe(0);
  });

  it('does not move when dt is 0 (alpha = 0)', () => {
    const p = makePlayer(0, 0);
    p.setTarget(100, 0, 0, 0);
    p.interpolate(0);
    expect(p.x).toBe(0);
    expect(p.y).toBe(0);
  });

  it('with a large dt converges nearly onto the predicted position', () => {
    const p = makePlayer(0, 0);
    p.setTarget(100, 50, 0, 0);
    p.interpolate(1000); // alpha → ~1
    expect(p.x).toBeCloseTo(100, 5);
    expect(p.y).toBeCloseTo(50, 5);
  });

  it('extrapolates from velocity but caps elapsed time at EXTRAP_MAX_MS', () => {
    const p = makePlayer(0, 0);
    // setTarget records lastUpdate = now (1000).
    p.setTarget(0, 0, 100, 0); // 100 px/s rightward velocity
    // Advance well beyond EXTRAP_MAX_MS so the cap kicks in.
    spyOn(performance, 'now').mockReturnValue(1000 + EXTRAP_MAX_MS + 5000);
    p.interpolate(1000); // converge onto the predicted (capped) point
    const expected = 100 * (EXTRAP_MAX_MS / 1000);
    expect(p.x).toBeCloseTo(expected, 5);
  });
});

describe('colorForId (via PlayerState.color)', () => {
  it('is deterministic for the same id', () => {
    const a = makePlayer(0, 0, 'same-id');
    const b = makePlayer(0, 0, 'same-id');
    expect(a.color).toBe(b.color);
  });

  it('produces a valid hsl string', () => {
    const p = makePlayer(0, 0, 'whatever');
    expect(p.color).toMatch(/^hsl\(\d{1,3}, 65%, 55%\)$/);
    const hue = Number(p.color.match(/^hsl\((\d+),/)![1]);
    expect(hue).toBeGreaterThanOrEqual(0);
    expect(hue).toBeLessThan(360);
  });

  it('differs for distinct ids (in general)', () => {
    const a = makePlayer(0, 0, 'alpha');
    const b = makePlayer(0, 0, 'beta');
    expect(a.color).not.toBe(b.color);
  });
});
