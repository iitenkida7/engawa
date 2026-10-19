// Speech-to-text through Groq's Whisper API.
//
// The audio goes from the browser straight to api.groq.com — it never passes
// through our own server (invariant #1), which the API makes possible by
// allowing cross-origin requests with an Authorization header. That also means
// the key is the user's own, kept in their browser and sent only to Groq: it is
// not a shared server-side credential like the Cloudflare tokens that
// invariant #3 keeps off the client.

const GROQ_TRANSCRIPTION_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';

export const GROQ_KEY_STORAGE = 'engawa-groq-key';
export const GROQ_MODEL_STORAGE = 'engawa-groq-model';

// turbo is ~3× cheaper and faster than the full model at slightly lower
// accuracy ($0.04 vs $0.111 per audio hour); for meeting notes that trade is
// worth it, so it is the default.
export const GROQ_MODELS = ['whisper-large-v3-turbo', 'whisper-large-v3'] as const;
export type GroqModel = (typeof GROQ_MODELS)[number];
export const DEFAULT_GROQ_MODEL: GroqModel = 'whisper-large-v3-turbo';

// Groq keys are issued with this prefix. Checked only to catch a mis-paste
// before the first request, never to gate the request itself.
const KEY_PREFIX = 'gsk_';
const KEY_MIN_LENGTH = 20;

const REQUEST_TIMEOUT_MS = 30_000;
// Only transient failures are retried (rate limit, upstream hiccup); a bad key
// or a malformed request would just fail again.
const RETRY_STATUSES = [429, 500, 502, 503, 504];
const MAX_ATTEMPTS = 3;
const RETRY_BASE_MS = 800;

// Pure: a syntactically plausible key, trimmed. Returns null when it clearly
// isn't one, so the settings UI can say so before any audio is sent.
export function parseGroqKey(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const key = raw.trim();
  if (!key.startsWith(KEY_PREFIX) || key.length < KEY_MIN_LENGTH) return null;
  return key;
}

// Pure: fall back to the default for anything we don't recognise, so a stale
// model name in localStorage can't wedge the feature.
export function parseGroqModel(raw: unknown): GroqModel {
  return GROQ_MODELS.includes(raw as GroqModel) ? (raw as GroqModel) : DEFAULT_GROQ_MODEL;
}

// Whisper was trained on captioned video, and when handed audio with no speech
// in it, it reproduces the boilerplate that padded those captions. Each of
// these is a whole-output match on a segment we already believed was speech —
// the phrases are common enough in subtitle corpora to appear from silence, and
// rare enough as a *complete* utterance in a meeting that dropping them beats
// letting them pile up in the notes.
const HALLUCINATIONS = [
  'ご視聴ありがとうございました',
  'ご視聴ありがとうございました。',
  'ご清聴ありがとうございました',
  'ご清聴ありがとうございました。',
  'チャンネル登録お願いします',
  'チャンネル登録よろしくお願いします',
  'おやすみなさい',
  'ありがとうございました',
  'ありがとうございました。',
  'Thank you for watching!',
  'Thanks for watching!',
  'Thank you.',
  'Please subscribe to my channel.',
  'you',
  'Bye.',
];

// Pure: tidy one API result and decide whether it is worth keeping. Returns an
// empty string for anything that should be dropped.
export function cleanTranscript(raw: string): string {
  const text = raw.trim();
  if (!text) return '';
  if (HALLUCINATIONS.some((h) => h.toLowerCase() === text.toLowerCase())) return '';
  return text;
}

// Whisper reports, per segment, how confident it was that there was speech at
// all. A segment it is fairly sure was silence, yet produced words for, is the
// classic hallucination — catching it by score rather than by phrase also
// covers the ones not on the list above.
const NO_SPEECH_LIMIT = 0.7;
const AVG_LOGPROB_LIMIT = -0.8;

type Segment = { no_speech_prob?: unknown; avg_logprob?: unknown };

// Pure: true when every segment looks like it was invented out of silence.
export function isHallucinated(raw: unknown): boolean {
  if (!Array.isArray(raw) || raw.length === 0) return false;
  return raw.every((seg) => {
    const { no_speech_prob: noSpeech, avg_logprob: logprob } = (seg ?? {}) as Segment;
    if (typeof noSpeech !== 'number' || typeof logprob !== 'number') return false;
    return noSpeech > NO_SPEECH_LIMIT && logprob < AVG_LOGPROB_LIMIT;
  });
}

export class GroqAuthError extends Error {}

export type TranscribeOptions = {
  apiKey: string;
  model: GroqModel;
  // ISO-639-1 ('ja', 'en'). Naming the language measurably beats letting the
  // model guess it, especially on short segments.
  language?: string;
  // Up to 224 tokens of context — we feed it the last few lines of the meeting
  // so names and jargon stay spelled consistently across segments.
  prompt?: string;
  signal?: AbortSignal;
};

// POST one WAV to Groq and return the recognised text ('' when there was
// nothing worth keeping). Throws GroqAuthError on a bad key so the caller can
// stop and prompt for a new one instead of retrying every segment.
export async function transcribeAudio(wav: ArrayBuffer, opts: TranscribeOptions): Promise<string> {
  const form = new FormData();
  form.append('file', new Blob([wav], { type: 'audio/wav' }), 'audio.wav');
  form.append('model', opts.model);
  // verbose_json carries the per-segment confidence scores that hallucination
  // filtering needs; temperature 0 makes the model far less inventive on the
  // near-silent segments where it invents text in the first place.
  form.append('response_format', 'verbose_json');
  form.append('temperature', '0');
  if (opts.language) form.append('language', opts.language);
  if (opts.prompt) form.append('prompt', opts.prompt);

  let lastError: Error | null = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) await delay(RETRY_BASE_MS * 2 ** (attempt - 1), opts.signal);
    try {
      const res = await fetch(GROQ_TRANSCRIPTION_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${opts.apiKey}` },
        body: form,
        // Uploads share the uplink with the call itself, where a stalled video
        // frame is far more noticeable than a transcript line arriving a moment
        // late. Ignored by browsers that don't implement priority hints.
        priority: 'low',
        signal: opts.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      } as RequestInit);
      if (res.status === 401 || res.status === 403) {
        throw new GroqAuthError(`Groq rejected the API key (${res.status})`);
      }
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        const err = new Error(`Groq transcription failed: ${res.status} ${detail.slice(0, 200)}`);
        if (!RETRY_STATUSES.includes(res.status)) throw err;
        lastError = err;
        continue;
      }
      const data = (await res.json()) as { text?: unknown; segments?: unknown };
      if (isHallucinated(data.segments)) return '';
      return cleanTranscript(typeof data.text === 'string' ? data.text : '');
    } catch (err) {
      // A bad key and a caller-driven abort are both final.
      if (err instanceof GroqAuthError) throw err;
      if (opts.signal?.aborted) throw err;
      lastError = err instanceof Error ? err : new Error(String(err));
    }
  }
  throw lastError ?? new Error('Groq transcription failed');
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new Error('aborted'));
      },
      { once: true },
    );
  });
}
