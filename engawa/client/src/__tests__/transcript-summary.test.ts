import { describe, expect, it } from 'bun:test';
import type { TranscriptEntry } from '@/ui/transcript';
import { splitInHalf, toSummaryInput } from '@/ui/transcript-summary';

// On-device transcript summary: the pure input-shaping helpers.

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

describe('splitInHalf', () => {
  it('cuts on the line break nearest the middle', () => {
    expect(splitInHalf('aaaa\nbbbb\ncccc')).toEqual(['aaaa\nbbbb', 'cccc']);
    expect(splitInHalf('aa\nbb\ncc\ndd')).toEqual(['aa\nbb', 'cc\ndd']);
  });

  it('cuts mid-line when there is no line break', () => {
    expect(splitInHalf('abcdef')).toEqual(['abc', 'def']);
  });

  it('keeps every character except the line break it cuts on', () => {
    const text = 'one\ntwo\nthree\nfour\nfive';
    const halves = splitInHalf(text);
    expect(halves?.join('\n')).toBe(text);
  });

  it('cannot split text shorter than two characters', () => {
    expect(splitInHalf('a')).toBeNull();
    expect(splitInHalf('')).toBeNull();
  });
});
