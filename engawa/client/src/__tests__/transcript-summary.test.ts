import { afterEach, describe, expect, it, mock } from 'bun:test';
import { GROQ_KEY_STORAGE, GroqAuthError } from '@/media/groq';
import type { TranscriptEntry } from '@/ui/transcript';
import {
  buildRequest,
  clipInput,
  MAX_INPUT_CHARS,
  summarize,
  toSummaryInput,
} from '@/ui/transcript-summary';

// Transcript summary with Groq: the pure request shaping, and the HTTP call
// against a stubbed fetch.

const entry = (speakerName: string, text: string): TranscriptEntry => ({
  speakerId: speakerName,
  speakerName,
  text,
  at: 0,
});

describe('toSummaryInput', () => {
  it('writes one "speaker: text" line per utterance, without timestamps', () => {
    expect(toSummaryInput([entry('田中', 'こんにちは'), entry('佐藤', 'おはよう')])).toBe(
      '田中: こんにちは\n佐藤: おはよう',
    );
  });

  it('is empty for an empty transcript', () => {
    expect(toSummaryInput([])).toBe('');
  });
});

describe('clipInput', () => {
  it('leaves a transcript that fits untouched', () => {
    expect(clipInput('abc', 10)).toBe('abc');
  });

  it('keeps the head and a longer tail of one that does not', () => {
    const text = 'a'.repeat(50) + 'b'.repeat(50);
    const clipped = clipInput(text, 10);
    expect(clipped).toBe(`aaaa\n…\nbbbbbb`);
  });

  it('defaults to a window a long meeting fits in', () => {
    expect(MAX_INPUT_CHARS).toBeGreaterThanOrEqual(50_000);
  });
});

describe('buildRequest', () => {
  it('sends the transcript as the user message under language-specific instructions', () => {
    const ja = buildRequest('田中: こんにちは', 'ja');
    expect(ja.messages[0]?.role).toBe('system');
    expect(ja.messages[0]?.content).toContain('日本語');
    expect(ja.messages[1]).toEqual({ role: 'user', content: '田中: こんにちは' });
    expect(buildRequest('x', 'en').messages[0]?.content).toContain('English');
  });
});

describe('summarize', () => {
  const realFetch = globalThis.fetch;
  const setKey = (key: string | null) => {
    if (key) localStorage.setItem(GROQ_KEY_STORAGE, key);
    else localStorage.removeItem(GROQ_KEY_STORAGE);
  };
  const stubFetch = (status: number, body: unknown) => {
    const fn = mock(
      async (_url: string, _init: RequestInit) => new Response(JSON.stringify(body), { status }),
    );
    globalThis.fetch = fn as unknown as typeof fetch;
    return fn;
  };

  afterEach(() => {
    globalThis.fetch = realFetch;
    setKey(null);
  });

  it("posts to Groq's chat API with the user's key and returns the reply", async () => {
    setKey('gsk_test_key_0123456789');
    const fn = stubFetch(200, { choices: [{ message: { content: '  ・決定: 来週リリース \n' } }] });
    expect(await summarize('田中: 来週出します', 'ja')).toBe('・決定: 来週リリース');
    const [url, init] = fn.mock.calls[0]!;
    expect(url).toBe('https://api.groq.com/openai/v1/chat/completions');
    expect((init.headers as Record<string, string>).Authorization).toBe(
      'Bearer gsk_test_key_0123456789',
    );
  });

  it('throws GroqAuthError without a key, before any request', async () => {
    const fn = stubFetch(200, {});
    await expect(summarize('x', 'ja')).rejects.toBeInstanceOf(GroqAuthError);
    expect(fn).not.toHaveBeenCalled();
  });

  it('throws GroqAuthError when Groq rejects the key', async () => {
    setKey('gsk_test_key_0123456789');
    stubFetch(401, { error: { message: 'Invalid API Key' } });
    await expect(summarize('x', 'ja')).rejects.toBeInstanceOf(GroqAuthError);
  });

  it('reports other failures with the status', async () => {
    setKey('gsk_test_key_0123456789');
    stubFetch(503, {});
    await expect(summarize('x', 'ja')).rejects.toThrow('HTTP 503');
  });
});
