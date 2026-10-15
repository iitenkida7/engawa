import { describe, expect, it } from 'bun:test';
import { isExperimentActive, parseExperimentalSetting } from '@/ui/experimental';

// Experimental features master switch (#323).

describe('parseExperimentalSetting', () => {
  it('is off unless explicitly enabled with "1"', () => {
    expect(parseExperimentalSetting(null)).toBe(false);
    expect(parseExperimentalSetting('0')).toBe(false);
    expect(parseExperimentalSetting('garbage')).toBe(false);
    expect(parseExperimentalSetting('1')).toBe(true);
  });
});

describe('isExperimentActive', () => {
  it('needs both the master switch and the feature toggle', () => {
    expect(isExperimentActive(true, true)).toBe(true);
    expect(isExperimentActive(true, false)).toBe(false);
    expect(isExperimentActive(false, true)).toBe(false);
    expect(isExperimentActive(false, false)).toBe(false);
  });
});
