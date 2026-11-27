// Summary of the transcript with a Groq-hosted LLM, using the same Groq key the
// transcriber already holds (media/groq.ts). The text goes from the browser
// straight to api.groq.com, exactly like the audio it was transcribed from —
// never through our own server (invariant #1) — and the key stays the user's
// own, in their browser.
//
// Prompt building and input shaping are pure and unit-tested; `summarize`
// only adds the HTTP call.

import type { Lang } from '@/core/i18n';
import { GroqAuthError } from '@/media/groq';
import type { TranscriptEntry } from '@/ui/transcript';
import { loadGroqKey } from '@/ui/transcript-setup';

const GROQ_CHAT_URL = 'https://api.groq.com/openai/v1/chat/completions';

// Large enough to follow a long meeting in one pass (131k-token window), and
// served on the same account and key as Whisper.
const SUMMARY_MODEL = 'openai/gpt-oss-120b';

const REQUEST_TIMEOUT_MS = 60_000;

// A very long meeting is cut to fit the model's window (roughly one token per
// Japanese character). The tail is kept longer: decisions tend to come last.
export const MAX_INPUT_CHARS = 80_000;

const INSTRUCTIONS: Record<Lang, string> = {
  ja: `あなたは会議の書記です。以下の会議の文字起こし（「話者: 発言」）を読み、日本語で要約してください。
- まず「決まったこと」「宿題（担当者がわかれば名前）」「次の予定」を箇条書きで。該当が無い項目は書かない（「なし」とも書かない）。
- 続けて、話した内容を議題ごとに短い箇条書きで。
- 各行は「・」で始めるプレーンテキスト。見出し以外に Markdown は使わない。
- 文字起こしに無いことは書かない。音声認識の誤字は文脈から自然に補う。`,
  en: `You are a meeting scribe. Read the meeting transcript below ("speaker: line") and summarize it in English.
- First list decisions, action items (with owners when known) and next steps. Leave out any that has none (do not write "none").
- Then summarize what was discussed, as short bullets grouped by topic.
- Plain text, each line starting with "• ". No Markdown.
- Do not add anything that is not in the transcript. It comes from speech recognition; read typos charitably.`,
};

// Pure: the transcript as model input. Timestamps are dropped — they cost
// tokens and add nothing to a summary.
export function toSummaryInput(entries: TranscriptEntry[]): string {
  return entries.map((e) => `${e.speakerName}: ${e.text}`).join('\n');
}

// Pure: keep the head and (a longer) tail of an over-long transcript.
export function clipInput(text: string, max = MAX_INPUT_CHARS): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.4);
  return `${text.slice(0, head)}\n…\n${text.slice(text.length - (max - head))}`;
}

// Pure: the chat request body.
export function buildRequest(text: string, lang: Lang) {
  return {
    model: SUMMARY_MODEL,
    messages: [
      { role: 'system', content: INSTRUCTIONS[lang] },
      { role: 'user', content: clipInput(text) },
    ],
    temperature: 0.2,
  };
}

// Whether this browser can summarise: it needs the Groq key that transcription
// uses. Checked on click, since the key can be set after the panel is built.
export function canSummarize(): boolean {
  return loadGroqKey() !== null;
}

// Summarise `text` with the user's Groq key. Throws GroqAuthError on a bad key.
export async function summarize(text: string, lang: Lang): Promise<string> {
  const apiKey = loadGroqKey();
  if (!apiKey) throw new GroqAuthError('no Groq API key');
  const res = await fetch(GROQ_CHAT_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(buildRequest(text, lang)),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (res.status === 401 || res.status === 403) {
    throw new GroqAuthError(`Groq rejected the API key (${res.status})`);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = (await res.json()) as { choices?: { message?: { content?: unknown } }[] };
  const content = json.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) throw new Error('empty response');
  return content.trim();
}
