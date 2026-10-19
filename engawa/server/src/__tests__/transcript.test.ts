import { describe, expect, test } from 'bun:test';
import {
  normalizeTranscriptAt,
  normalizeTranscriptText,
  parseGroupMembers,
  TRANSCRIPT_CLOCK_SKEW_MS,
  TRANSCRIPT_MAX_LENGTH,
} from '../logic';

// Live transcription relay (Groq speech-to-text, run in the browser). The audio
// never reaches this server — it only validates the resulting text and passes
// it to the sender's own call.

describe('normalizeTranscriptText', () => {
  test('keeps ordinary speech, trimmed', () => {
    expect(normalizeTranscriptText('  今日の議題です  ')).toBe('今日の議題です');
  });

  test('replaces control characters so one utterance stays one line', () => {
    expect(normalizeTranscriptText('前半\n後半')).toBe('前半 後半');
    expect(normalizeTranscriptText('a\tb')).toBe('a b');
    expect(normalizeTranscriptText('\u0007bell')).toBe('bell');
  });

  test('drops anything empty or not a string', () => {
    expect(normalizeTranscriptText('')).toBeNull();
    expect(normalizeTranscriptText('   ')).toBeNull();
    expect(normalizeTranscriptText('\n\n')).toBeNull();
    expect(normalizeTranscriptText(null)).toBeNull();
    expect(normalizeTranscriptText(42)).toBeNull();
    expect(normalizeTranscriptText({})).toBeNull();
  });

  test('drops an over-long line', () => {
    expect(normalizeTranscriptText('あ'.repeat(TRANSCRIPT_MAX_LENGTH))).not.toBeNull();
    expect(normalizeTranscriptText('あ'.repeat(TRANSCRIPT_MAX_LENGTH + 1))).toBeNull();
  });
});

describe('normalizeTranscriptAt', () => {
  const now = 1_700_000_000_000;

  test('keeps a plausible timestamp', () => {
    expect(normalizeTranscriptAt(now - 5_000, now)).toBe(now - 5_000);
  });

  test('falls back to the server clock for a wrong or missing one', () => {
    expect(normalizeTranscriptAt(now - TRANSCRIPT_CLOCK_SKEW_MS - 1, now)).toBe(now);
    expect(normalizeTranscriptAt(now + TRANSCRIPT_CLOCK_SKEW_MS + 1, now)).toBe(now);
    expect(normalizeTranscriptAt(undefined, now)).toBe(now);
    expect(normalizeTranscriptAt('yesterday', now)).toBe(now);
    expect(normalizeTranscriptAt(Number.NaN, now)).toBe(now);
  });
});

describe('parseGroupMembers', () => {
  test('reads the members out of a group signature', () => {
    expect(parseGroupMembers('sfu:a,b,c')).toEqual(['a', 'b', 'c']);
    expect(parseGroupMembers('mesh:a,b')).toEqual(['a', 'b']);
    expect(parseGroupMembers('sfu:solo')).toEqual(['solo']);
  });

  test('returns nothing for a client that is not in a group', () => {
    expect(parseGroupMembers(null)).toEqual([]);
    expect(parseGroupMembers(undefined)).toEqual([]);
    expect(parseGroupMembers('')).toEqual([]);
    expect(parseGroupMembers('sfu:')).toEqual([]);
    expect(parseGroupMembers('no-colon')).toEqual([]);
  });
});
