import { describe, expect, it } from 'bun:test';
import { reactionAnim, truncateNote } from '@/world/canvas';
import { REACTION_LIFETIME_MS } from '@/core/types';

describe('truncateNote', () => {
  it('keeps a short note as-is, trimmed', () => {
    expect(truncateNote('  ランチ  ')).toBe('ランチ');
  });

  it('truncates a long note with an ellipsis', () => {
    expect(truncateNote('あいうえおかきくけこさし', 5)).toBe('あいうえ…');
  });

  it('returns empty for an empty or whitespace-only note', () => {
    expect(truncateNote('')).toBe('');
    expect(truncateNote('   ')).toBe('');
  });
});

describe('reactionAnim', () => {
  it('starts fully opaque with no rise', () => {
    expect(reactionAnim(0)).toEqual({ alpha: 1, rise: 0 });
  });

  it('fades and rises monotonically through its lifetime', () => {
    const mid = reactionAnim(REACTION_LIFETIME_MS / 2);
    expect(mid).not.toBeNull();
    expect(mid!.alpha).toBeCloseTo(0.5, 5);
    expect(mid!.rise).toBeGreaterThan(0);
    // Later in the lifetime it is more faded and has risen further.
    const late = reactionAnim((REACTION_LIFETIME_MS * 3) / 4)!;
    expect(late.alpha).toBeLessThan(mid!.alpha);
    expect(late.rise).toBeGreaterThan(mid!.rise);
  });

  it('returns null once expired (at or past the lifetime)', () => {
    expect(reactionAnim(REACTION_LIFETIME_MS)).toBeNull();
    expect(reactionAnim(REACTION_LIFETIME_MS + 100)).toBeNull();
  });

  it('returns null for negative elapsed time', () => {
    expect(reactionAnim(-1)).toBeNull();
  });

  it('honors a custom lifetime', () => {
    expect(reactionAnim(50, 100)).toEqual({ alpha: 0.5, rise: 18 });
    expect(reactionAnim(100, 100)).toBeNull();
  });
});
