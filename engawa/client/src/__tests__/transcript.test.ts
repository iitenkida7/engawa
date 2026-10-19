import { describe, expect, it } from 'bun:test';
import { formatClock, type TranscriptEntry, toPlainText } from '@/ui/transcript';

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
