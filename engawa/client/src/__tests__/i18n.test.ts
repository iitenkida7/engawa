import { describe, expect, test } from 'bun:test';
import { resolveLang, t } from '@/core/i18n';

describe('resolveLang', () => {
  test('a valid stored choice wins over the browser language', () => {
    expect(resolveLang('ja', 'en-US')).toBe('ja');
    expect(resolveLang('en', 'ja-JP')).toBe('en');
  });

  test('falls back to the browser/OS language when nothing is stored', () => {
    expect(resolveLang(null, 'ja')).toBe('ja');
    expect(resolveLang(null, 'ja-JP')).toBe('ja');
    expect(resolveLang(null, 'en-US')).toBe('en');
    expect(resolveLang(null, 'fr-FR')).toBe('en');
  });

  test('defaults to English when the browser language is missing', () => {
    expect(resolveLang(null, undefined)).toBe('en');
    expect(resolveLang(null, '')).toBe('en');
  });

  test('an invalid stored value is ignored in favour of the browser language', () => {
    expect(resolveLang('zz', 'ja')).toBe('ja');
    expect(resolveLang('', 'en')).toBe('en');
  });
});

describe('t', () => {
  test('returns a real string for a known key (not the key itself)', () => {
    const s = t('join.enter');
    expect(typeof s).toBe('string');
    expect(s.length).toBeGreaterThan(0);
    expect(s).not.toBe('join.enter');
  });

  test('falls back to the key when it is unknown', () => {
    expect(t('no.such.key')).toBe('no.such.key');
  });

  test('interpolates {var} params', () => {
    expect(t('roster.minutes', { n: 15 })).toContain('15');
    expect(t('media.screenOf', { name: 'Alice' })).toContain('Alice');
  });
});
