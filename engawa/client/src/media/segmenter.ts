// Utterance segmentation for speech-to-text: decide where one chunk of speech
// ends and the next begins, so each POST to the API is a whole thought rather
// than an arbitrary slice of the clock.
//
// The tap worklet (media/pcm-tap-worklet.ts) hands us fixed 100ms blocks with
// their loudness already measured; everything here is pure state-machine work
// on that sequence, so it unit-tests without Web Audio. Mirrors how
// media/voice-gate.ts splits its logic from the worklet that drives it.

// Registered name of the tap AudioWorkletProcessor. Lives here rather than in
// the worklet module because importing that on the main thread would run its
// registerProcessor() call (same reason as NOISE_WORKLET_NAME).
export const PCM_TAP_WORKLET_NAME = 'engawa-pcm-tap';

// Block size the worklet accumulates before posting, in milliseconds. Also the
// resolution of every threshold below.
export const BLOCK_MS = 100;

// Loudness (RMS, 0..1) above which a block counts as speech. Deliberately low:
// this only has to beat a quiet room, because the mic we tap has already been
// through RNNoise and the voice gate, which mute non-speech outright.
// The transcriber also zeroes a block's level while the speaker's tile isn't lit
// green (media/speaking.ts), so this is a floor, not the main speech test.
export const SPEECH_RMS = 0.01;

// Silence this long ends an utterance. Long enough to ride over the pauses
// inside a sentence, short enough that a reply lands in its own segment.
export const SILENCE_MS = 900;

// Hard cap on one segment. Whisper reasons over a 30s window, so cutting below
// that keeps every request inside the model's comfort zone even when someone
// talks without pausing.
export const MAX_SEGMENT_MS = 25_000;

// Segments with less actual speech than this are dropped unsent: a cough or a
// chair creak that cleared the RMS threshold for a moment costs a request and
// returns noise (or a hallucinated line). Counted over the blocks that crossed
// the threshold, not the span from first to last, so two creaks with near
// silence between them don't add up to an "utterance".
export const MIN_SEGMENT_MS = 400;

// Blocks of room tone kept ahead of the first speech block. The RMS threshold
// trips a little after a word actually starts, so without this the leading
// consonant is clipped and "そうですね" arrives as "うですね".
export const PREROLL_BLOCKS = 3;

export type SegmentState = {
  // Blocks held for the current segment, oldest first.
  blocks: Float32Array[];
  // Consecutive trailing blocks below the speech threshold.
  silentBlocks: number;
  // Whether any block in this segment has crossed the speech threshold.
  speechSeen: boolean;
  // How many blocks in this segment crossed the speech threshold.
  voicedBlocks: number;
};

export function newSegmentState(): SegmentState {
  return { blocks: [], silentBlocks: 0, speechSeen: false, voicedBlocks: 0 };
}

export type SegmentAction =
  // Keep accumulating; nothing to send yet.
  | { type: 'hold' }
  // The segment is complete: these blocks are ready to encode and upload.
  | { type: 'emit'; blocks: Float32Array[] }
  // The segment ended but was too short to be worth a request.
  | { type: 'discard' };

// Pure: fold one block into the segment and say what to do with the result.
// The caller replaces its state with `state` after each call (mutated in place,
// like GatedDenoiser's buffers, to avoid churning arrays 10× a second).
export function pushBlock(state: SegmentState, block: Float32Array, rms: number): SegmentAction {
  const isSpeech = rms >= SPEECH_RMS;

  if (!state.speechSeen && !isSpeech) {
    // Still waiting for someone to talk: keep just enough room tone to protect
    // the start of the first word.
    state.blocks.push(block);
    if (state.blocks.length > PREROLL_BLOCKS) state.blocks.shift();
    return { type: 'hold' };
  }

  state.blocks.push(block);
  if (isSpeech) {
    state.speechSeen = true;
    state.voicedBlocks++;
    state.silentBlocks = 0;
  } else {
    state.silentBlocks++;
  }

  const silentMs = state.silentBlocks * BLOCK_MS;
  const totalMs = state.blocks.length * BLOCK_MS;
  if (silentMs < SILENCE_MS && totalMs < MAX_SEGMENT_MS) return { type: 'hold' };

  const speechMs = state.voicedBlocks * BLOCK_MS;
  const blocks = state.blocks;
  reset(state);
  if (speechMs < MIN_SEGMENT_MS) return { type: 'discard' };
  return { type: 'emit', blocks };
}

// Pure: end the current segment early (mic switched off, call ended, the user
// stopped transcribing) and hand back whatever is worth sending.
export function flushSegment(state: SegmentState): SegmentAction {
  const speechMs = state.voicedBlocks * BLOCK_MS;
  const blocks = state.blocks;
  const speechSeen = state.speechSeen;
  reset(state);
  if (!speechSeen || speechMs < MIN_SEGMENT_MS) return { type: 'discard' };
  return { type: 'emit', blocks };
}

function reset(state: SegmentState) {
  state.blocks = [];
  state.silentBlocks = 0;
  state.speechSeen = false;
  state.voicedBlocks = 0;
}

// Pure: flatten a segment's blocks into one contiguous buffer for the encoder.
export function concatBlocks(blocks: Float32Array[]): Float32Array {
  let total = 0;
  for (const b of blocks) total += b.length;
  const out = new Float32Array(total);
  let offset = 0;
  for (const b of blocks) {
    out.set(b, offset);
    offset += b.length;
  }
  return out;
}

// Pure: root-mean-square loudness of a block, 0..1.
export function rms(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / samples.length);
}
