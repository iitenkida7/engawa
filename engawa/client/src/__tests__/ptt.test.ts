import { describe, expect, it } from 'bun:test';
import { isPttKey, parsePttSetting } from '@/ui/ptt';

// Push-to-talk (experimental).

describe('parsePttSetting', () => {
  it('is on unless explicitly disabled with "0"', () => {
    expect(parsePttSetting(null)).toBe(true);
    expect(parsePttSetting('1')).toBe(true);
    expect(parsePttSetting('0')).toBe(false);
  });
});

describe('isPttKey', () => {
  it('matches the bare V key, either case', () => {
    expect(isPttKey({ key: 'v' })).toBe(true);
    expect(isPttKey({ key: 'V' })).toBe(true);
  });

  it('ignores other keys', () => {
    expect(isPttKey({ key: 'm' })).toBe(false);
  });

  it('ignores modifier combos and IME composition', () => {
    expect(isPttKey({ key: 'v', metaKey: true })).toBe(false);
    expect(isPttKey({ key: 'v', ctrlKey: true })).toBe(false);
    expect(isPttKey({ key: 'v', altKey: true })).toBe(false);
    expect(isPttKey({ key: 'V', shiftKey: true })).toBe(false);
    expect(isPttKey({ key: 'v', isComposing: true })).toBe(false);
  });
});
