import { describe, expect, it } from 'bun:test';
import { isPttKey, parsePttSetting } from '@/ui/ptt';

// Push-to-talk.

describe('parsePttSetting', () => {
  it('is off unless explicitly enabled with "1"', () => {
    expect(parsePttSetting(null)).toBe(false);
    expect(parsePttSetting('0')).toBe(false);
    expect(parsePttSetting('1')).toBe(true);
  });
});

describe('isPttKey', () => {
  it('matches the bare Space key', () => {
    expect(isPttKey({ key: ' ' })).toBe(true);
  });

  it('ignores other keys', () => {
    expect(isPttKey({ key: 'v' })).toBe(false);
    expect(isPttKey({ key: 'm' })).toBe(false);
  });

  it('ignores modifier combos and IME composition', () => {
    expect(isPttKey({ key: ' ', metaKey: true })).toBe(false);
    expect(isPttKey({ key: ' ', ctrlKey: true })).toBe(false);
    expect(isPttKey({ key: ' ', altKey: true })).toBe(false);
    expect(isPttKey({ key: ' ', shiftKey: true })).toBe(false);
    expect(isPttKey({ key: ' ', isComposing: true })).toBe(false);
  });
});
