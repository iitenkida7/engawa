import { describe, expect, it } from 'bun:test';
import { computeReconnectDelay, RECONNECT_BASE_MS, RECONNECT_MAX_MS } from '@/core/reconnect';

describe('computeReconnectDelay', () => {
  it('doubles the backoff each attempt (midpoint jitter)', () => {
    // rand=0.5 → half + half*0.5 = capped*0.75, so the doubling is still visible.
    expect(computeReconnectDelay(0, 0.5)).toBe(Math.round(RECONNECT_BASE_MS * 0.75));
    expect(computeReconnectDelay(1, 0.5)).toBe(Math.round(RECONNECT_BASE_MS * 2 * 0.75));
    expect(computeReconnectDelay(2, 0.5)).toBe(Math.round(RECONNECT_BASE_MS * 4 * 0.75));
  });

  it('applies equal jitter within [capped/2, capped]', () => {
    // attempt 0 → capped = base. rand spans the random half.
    expect(computeReconnectDelay(0, 0)).toBe(RECONNECT_BASE_MS / 2);
    expect(computeReconnectDelay(0, 1)).toBe(RECONNECT_BASE_MS);
  });

  it('caps the backoff at the ceiling and never exceeds it', () => {
    // A large attempt would overflow without the cap; with it, even max jitter
    // (rand=1) lands exactly on the ceiling, never above.
    expect(computeReconnectDelay(50, 1)).toBe(RECONNECT_MAX_MS);
    expect(computeReconnectDelay(50, 0)).toBe(RECONNECT_MAX_MS / 2);
    expect(computeReconnectDelay(50, 0.5)).toBeLessThanOrEqual(RECONNECT_MAX_MS);
  });

  it('clamps out-of-range random inputs', () => {
    expect(computeReconnectDelay(0, -5)).toBe(RECONNECT_BASE_MS / 2);
    expect(computeReconnectDelay(0, 9)).toBe(RECONNECT_BASE_MS);
  });

  it('treats negative attempts as attempt 0', () => {
    expect(computeReconnectDelay(-3, 0.5)).toBe(computeReconnectDelay(0, 0.5));
  });

  it('honours custom base/max options', () => {
    expect(computeReconnectDelay(0, 1, { baseMs: 500 })).toBe(500);
    expect(computeReconnectDelay(10, 1, { baseMs: 500, maxMs: 4000 })).toBe(4000);
  });
});
