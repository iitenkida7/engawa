// On-device summary of the transcript with Chrome's built-in Summarizer API
// (Gemini Nano). The text never leaves the browser — no key, no request — so it
// sits well with invariant #1. Desktop Chrome only; elsewhere the API is absent
// and the panel simply doesn't offer the button.
//
// The model reads a small window, so a long meeting is summarised in halves
// and the halves' summaries are summarised again until one pass fits. The
// splitting helpers are pure and unit-tested.

import type { Lang } from '@/core/i18n';
import type { TranscriptEntry } from '@/ui/transcript';

type Availability = 'unavailable' | 'downloadable' | 'downloading' | 'available';

type SummarizerOptions = {
  type?: 'key-points' | 'tldr' | 'teaser' | 'headline';
  format?: 'plain-text' | 'markdown';
  length?: 'short' | 'medium' | 'long';
  sharedContext?: string;
  expectedInputLanguages?: string[];
  outputLanguage?: string;
  monitor?: (m: EventTarget) => void;
};

type Summarizer = {
  inputQuota: number;
  measureInputUsage(input: string): Promise<number>;
  summarize(input: string): Promise<string>;
  destroy(): void;
};

type SummarizerApi = {
  availability(opts?: SummarizerOptions): Promise<Availability>;
  create(opts?: SummarizerOptions): Promise<Summarizer>;
};

function api(): SummarizerApi | undefined {
  return (globalThis as { Summarizer?: SummarizerApi }).Summarizer;
}

function options(lang: Lang): SummarizerOptions {
  return {
    type: 'key-points',
    format: 'plain-text',
    length: 'medium',
    sharedContext:
      lang === 'ja' ? '会議の文字起こし（話者: 発言）' : 'Meeting transcript (speaker: line)',
    expectedInputLanguages: [lang],
    outputLanguage: lang,
  };
}

// Pure: the transcript as model input. Timestamps are dropped — they cost
// window space and add nothing to a summary.
export function toSummaryInput(entries: TranscriptEntry[]): string {
  return entries.map((e) => `${e.speakerName}: ${e.text}`).join('\n');
}

// Pure: cut text in two near the middle, on a line break when there is one, so
// each half can be summarised on its own. Null when it can't be split further.
export function splitInHalf(text: string): [string, string] | null {
  if (text.length < 2) return null;
  const mid = Math.floor(text.length / 2);
  const before = text.lastIndexOf('\n', mid);
  const after = text.indexOf('\n', mid);
  let cut = -1;
  if (before > 0 && after > 0) cut = mid - before <= after - mid ? before : after;
  else cut = before > 0 ? before : after;
  if (cut <= 0) return [text.slice(0, mid), text.slice(mid)];
  return [text.slice(0, cut), text.slice(cut + 1)];
}

// Whether this browser can summarise in `lang` at all (possibly after a
// one-time model download).
export async function canSummarize(lang: Lang): Promise<boolean> {
  const s = api();
  if (!s) return false;
  try {
    return (await s.availability(options(lang))) !== 'unavailable';
  } catch {
    return false;
  }
}

// Summarise `text`. `onDownload` reports model download progress (0..1), only
// while the model is actually missing: Chrome fires 0 and 1 progress events
// even when it is already on disk. Must be called from a click: creating the
// summarizer may start that download, which needs user activation.
export async function summarize(
  text: string,
  lang: Lang,
  onDownload: (fraction: number) => void,
): Promise<string> {
  const s = api();
  if (!s) throw new Error('Summarizer unavailable');
  const needsDownload = (await s.availability(options(lang))) !== 'available';
  const summarizer = await s.create({
    ...options(lang),
    monitor: (m) => {
      if (!needsDownload) return;
      m.addEventListener('downloadprogress', (e) => onDownload((e as ProgressEvent).loaded));
    },
  });
  try {
    return await fit(summarizer, text);
  } finally {
    summarizer.destroy();
  }
}

async function fit(summarizer: Summarizer, text: string): Promise<string> {
  if ((await summarizer.measureInputUsage(text)) <= summarizer.inputQuota) {
    return summarizer.summarize(text);
  }
  const halves = splitInHalf(text);
  if (!halves) return summarizer.summarize(text);
  // Sequential: the on-device model runs one request at a time anyway.
  const first = await fit(summarizer, halves[0]);
  const second = await fit(summarizer, halves[1]);
  const merged = `${first}\n${second}`;
  // Guard against a model that doesn't shrink its input: stop rather than loop.
  return merged.length < text.length ? fit(summarizer, merged) : merged;
}
