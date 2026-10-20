import { describe, expect, it } from 'bun:test';
import {
  BLOCK_MS,
  concatBlocks,
  flushSegment,
  MAX_SEGMENT_MS,
  MIN_SEGMENT_MS,
  newSegmentState,
  PREROLL_BLOCKS,
  pushBlock,
  rms,
  SILENCE_MS,
  SPEECH_RMS,
} from '@/media/segmenter';

// Utterance segmentation: where one chunk of speech ends and the next begins.

const LOUD = SPEECH_RMS * 2;
const QUIET = SPEECH_RMS / 2;
const block = () => new Float32Array(16);

// Feed n blocks at one loudness and return the last action.
function feed(state: ReturnType<typeof newSegmentState>, n: number, level: number) {
  let action = pushBlock(state, block(), level);
  for (let i = 1; i < n; i++) action = pushBlock(state, block(), level);
  return action;
}

describe('pushBlock', () => {
  it('holds while nobody is talking, keeping only a short preroll', () => {
    const state = newSegmentState();
    const action = feed(state, 50, QUIET);
    expect(action.type).toBe('hold');
    // Silence must not accumulate without bound — only the preroll is kept.
    expect(state.blocks.length).toBe(PREROLL_BLOCKS);
  });

  it('keeps preroll blocks so the start of a word is not clipped', () => {
    const state = newSegmentState();
    feed(state, PREROLL_BLOCKS, QUIET);
    pushBlock(state, block(), LOUD);
    expect(state.blocks.length).toBe(PREROLL_BLOCKS + 1);
    expect(state.speechSeen).toBe(true);
  });

  it('emits once speech is followed by a long enough silence', () => {
    const state = newSegmentState();
    const speechBlocks = Math.ceil(MIN_SEGMENT_MS / BLOCK_MS) + 1;
    feed(state, speechBlocks, LOUD);
    const silenceBlocks = SILENCE_MS / BLOCK_MS;
    let action = feed(state, silenceBlocks - 1, QUIET);
    expect(action.type).toBe('hold');
    action = pushBlock(state, block(), QUIET);
    expect(action.type).toBe('emit');
    if (action.type === 'emit') expect(action.blocks.length).toBeGreaterThan(speechBlocks);
    // State resets so the next utterance starts clean.
    expect(state.blocks.length).toBe(0);
    expect(state.speechSeen).toBe(false);
  });

  it('rides over short pauses inside a sentence', () => {
    const state = newSegmentState();
    feed(state, 10, LOUD);
    const action = feed(state, SILENCE_MS / BLOCK_MS - 1, QUIET);
    expect(action.type).toBe('hold');
  });

  it('discards a blip too short to be worth a request', () => {
    const state = newSegmentState();
    pushBlock(state, block(), LOUD); // one 100ms block, under MIN_SEGMENT_MS
    const action = feed(state, SILENCE_MS / BLOCK_MS, QUIET);
    expect(action.type).toBe('discard');
  });

  it('discards blips with near silence between them', () => {
    // Two short sounds, each pause just under SILENCE_MS: the span from first
    // to last is long, but almost none of it is speech.
    const state = newSegmentState();
    pushBlock(state, block(), LOUD);
    feed(state, SILENCE_MS / BLOCK_MS - 1, QUIET);
    pushBlock(state, block(), LOUD);
    const action = feed(state, SILENCE_MS / BLOCK_MS, QUIET);
    expect(action.type).toBe('discard');
  });

  it('cuts a monologue at the maximum segment length', () => {
    const state = newSegmentState();
    const action = feed(state, MAX_SEGMENT_MS / BLOCK_MS, LOUD);
    expect(action.type).toBe('emit');
  });
});

describe('flushSegment', () => {
  it('emits speech captured so far', () => {
    const state = newSegmentState();
    feed(state, Math.ceil(MIN_SEGMENT_MS / BLOCK_MS) + 1, LOUD);
    const action = flushSegment(state);
    expect(action.type).toBe('emit');
    expect(state.blocks.length).toBe(0);
  });

  it('discards when there was no speech at all', () => {
    const state = newSegmentState();
    feed(state, 3, QUIET);
    expect(flushSegment(state).type).toBe('discard');
  });

  it('discards a too-short utterance', () => {
    const state = newSegmentState();
    pushBlock(state, block(), LOUD);
    expect(flushSegment(state).type).toBe('discard');
  });
});

describe('concatBlocks', () => {
  it('joins blocks in order', () => {
    const out = concatBlocks([new Float32Array([1, 2]), new Float32Array([3])]);
    expect([...out]).toEqual([1, 2, 3]);
  });

  it('returns an empty buffer for no blocks', () => {
    expect(concatBlocks([]).length).toBe(0);
  });
});

describe('rms', () => {
  it('is zero for silence and one for full scale', () => {
    expect(rms(new Float32Array(8))).toBe(0);
    expect(rms(new Float32Array([1, -1, 1, -1]))).toBeCloseTo(1, 5);
  });

  it('is zero for an empty buffer', () => {
    expect(rms(new Float32Array(0))).toBe(0);
  });
});
