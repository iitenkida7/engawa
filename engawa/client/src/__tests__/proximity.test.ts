import { describe, expect, it } from 'bun:test';
import { isInitiator } from '@/core/proximity';

describe('isInitiator', () => {
  it('the lexicographically smaller id initiates', () => {
    expect(isInitiator('aaa', 'bbb')).toBe(true);
    expect(isInitiator('bbb', 'aaa')).toBe(false);
  });
  it('elects exactly one initiator for a pair', () => {
    const a = 'user-1';
    const b = 'user-2';
    expect(isInitiator(a, b)).not.toBe(isInitiator(b, a));
  });
});
