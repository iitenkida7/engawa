import { describe, expect, it } from 'bun:test';
import {
  continuesGroup,
  formatClock,
  sessionLabel,
  TRANSCRIPT_GROUP_GAP_MS,
  type TranscriptEntry,
  toPlainText,
} from '@/ui/transcript';

// Transcript formatting (the panel's pure helpers).

const entry = (over: Partial<TranscriptEntry> = {}): TranscriptEntry => ({
  speakerId: 'u1',
  speakerName: '田中',
  text: 'こんにちは',
  at: new Date(2026, 0, 2, 9, 5, 7).getTime(),
  ...over,
});

describe('formatClock', () => {
  it('pads to HH:MM:SS in local time', () => {
    expect(formatClock(new Date(2026, 0, 2, 9, 5, 7).getTime())).toBe('09:05:07');
    expect(formatClock(new Date(2026, 0, 2, 23, 59, 59).getTime())).toBe('23:59:59');
  });
});

describe('toPlainText', () => {
  it('writes one timestamped line per utterance', () => {
    const text = toPlainText([
      entry(),
      entry({ speakerName: '佐藤', text: 'おはよう', at: new Date(2026, 0, 2, 9, 6, 0).getTime() }),
    ]);
    expect(text).toBe('[09:05:07] 田中: こんにちは\n[09:06:00] 佐藤: おはよう');
  });

  it('is empty for an empty transcript', () => {
    expect(toPlainText([])).toBe('');
  });
});

describe('continuesGroup', () => {
  it('starts a new group for the first line', () => {
    expect(continuesGroup(undefined, entry())).toBe(false);
  });

  it('stacks a quick follow-up from the same speaker', () => {
    const prev = entry();
    expect(continuesGroup(prev, entry({ at: prev.at + 5_000 }))).toBe(true);
  });

  it('starts a new group when the speaker changes', () => {
    const prev = entry();
    expect(continuesGroup(prev, entry({ speakerId: 'u2', at: prev.at + 1_000 }))).toBe(false);
  });

  it('starts a new group after a long pause', () => {
    const prev = entry();
    expect(continuesGroup(prev, entry({ at: prev.at + TRANSCRIPT_GROUP_GAP_MS }))).toBe(false);
  });
});

describe('sessionLabel', () => {
  it('shows the start time (HH:MM) and the number of lines', () => {
    const label = sessionLabel({ id: 1, startedAt: entry().at, entries: [entry(), entry()] });
    expect(label).toContain('09:05');
    expect(label).toContain('2');
    expect(label).not.toContain('09:05:07');
  });
});
