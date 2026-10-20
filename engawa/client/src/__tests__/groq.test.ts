import { describe, expect, it } from 'bun:test';
import {
  cleanTranscript,
  isHallucinated,
  parseGroqKey,
  parseRateLimit,
  retryDelayMs,
} from '@/media/groq';

// The Groq Whisper client's pure parts: settings parsing and the filters that
// keep invented text out of the transcript.

describe('parseGroqKey', () => {
  it('accepts a plausible key and trims it', () => {
    expect(parseGroqKey('  gsk_abcdefghijklmnopqrstuv  ')).toBe('gsk_abcdefghijklmnopqrstuv');
  });

  it('rejects anything that is not a Groq key', () => {
    expect(parseGroqKey(null)).toBeNull();
    expect(parseGroqKey('')).toBeNull();
    expect(parseGroqKey('sk-openai-style-key-here')).toBeNull();
    expect(parseGroqKey('gsk_short')).toBeNull();
    expect(parseGroqKey(12345)).toBeNull();
  });
});

describe('cleanTranscript', () => {
  it('keeps real speech, trimmed', () => {
    expect(cleanTranscript('  こんにちは  ')).toBe('こんにちは');
  });

  it('drops the caption boilerplate Whisper invents from silence', () => {
    expect(cleanTranscript('ご視聴ありがとうございました')).toBe('');
    expect(cleanTranscript('Thank you for watching!')).toBe('');
    expect(cleanTranscript('  thanks for watching!  ')).toBe('');
  });

  it('keeps a boilerplate phrase that is part of a longer sentence', () => {
    const text = 'ご視聴ありがとうございました、と言って締めましょう';
    expect(cleanTranscript(text)).toBe(text);
  });

  it('drops empty output', () => {
    expect(cleanTranscript('   ')).toBe('');
  });
});

describe('isHallucinated', () => {
  const invented = { no_speech_prob: 0.95, avg_logprob: -1.2 };
  const real = { no_speech_prob: 0.05, avg_logprob: -0.2 };

  it('flags output where every segment looks like it came from silence', () => {
    expect(isHallucinated([invented])).toBe(true);
    expect(isHallucinated([invented, invented])).toBe(true);
  });

  it('keeps output with any confident speech in it', () => {
    expect(isHallucinated([invented, real])).toBe(false);
    expect(isHallucinated([real])).toBe(false);
  });

  it('keeps output when the scores are missing or malformed', () => {
    expect(isHallucinated(undefined)).toBe(false);
    expect(isHallucinated([])).toBe(false);
    expect(isHallucinated([{}])).toBe(false);
    expect(isHallucinated('nonsense')).toBe(false);
  });
});

describe('retryDelayMs', () => {
  it('backs off exponentially, capped at 30s', () => {
    expect(retryDelayMs(1)).toBe(800);
    expect(retryDelayMs(2)).toBe(1_600);
    expect(retryDelayMs(3)).toBe(3_200);
    expect(retryDelayMs(20)).toBe(30_000);
  });

  it('honours Retry-After in seconds', () => {
    expect(retryDelayMs(1, '7')).toBe(7_000);
    expect(retryDelayMs(5, '0')).toBe(0);
    expect(retryDelayMs(1, '3600')).toBe(30_000);
  });

  it('honours Retry-After as an HTTP date', () => {
    const now = Date.parse('2026-10-19T00:00:00Z');
    expect(retryDelayMs(1, 'Mon, 19 Oct 2026 00:00:05 GMT', now)).toBe(5_000);
  });

  it('falls back to the backoff for a malformed or past Retry-After', () => {
    expect(retryDelayMs(2, 'soon')).toBe(1_600);
    expect(retryDelayMs(2, '-5')).toBe(1_600);
  });
});

describe('parseRateLimit', () => {
  const body = (message: string) =>
    JSON.stringify({ error: { message, type: 'tokens', code: 'rate_limit_exceeded' } });

  it('reads the limit and the wait from a Groq 429 body', () => {
    expect(
      parseRateLimit(
        body(
          'Rate limit reached for model `whisper-large-v3-turbo` in organization `org_x` service tier `on_demand` on audio seconds per hour (ASH): Limit 7200, Used 7195, Requested 20. Please try again in 6m12.5s. Need more tokens? Upgrade to Dev Tier today at https://console.groq.com/settings/billing',
        ),
      ),
    ).toEqual({ kind: 'ASH', waitSec: 372.5 });
  });

  it('adds up hours, minutes and seconds', () => {
    expect(
      parseRateLimit(
        body('... on requests per day (RPD): Limit 2000, Used 2000. Please try again in 1h2m3s.'),
      ),
    ).toEqual({ kind: 'RPD', waitSec: 3723 });
    expect(parseRateLimit(body('... (RPM): Limit 20. Please try again in 2.4s.'))).toEqual({
      kind: 'RPM',
      waitSec: 2.4,
    });
  });

  it('leaves out what it cannot find', () => {
    expect(parseRateLimit(body('Too many requests'))).toEqual({ kind: null, waitSec: null });
    expect(parseRateLimit('')).toEqual({ kind: null, waitSec: null });
    expect(parseRateLimit('upstream (ASD) busy, try again in 30s')).toEqual({
      kind: 'ASD',
      waitSec: 30,
    });
  });
});
