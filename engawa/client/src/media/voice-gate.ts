// Voice gate behind the mic noise suppressor (media/noise.ts). RNNoise already
// computes, for every 10ms frame it denoises, the probability that the frame
// contains a human voice — the old worklet just threw it away. Here we reuse it
// to fully mute the mic between utterances, so the non-stationary noise RNNoise
// can't remove on its own (a passing motorbike, birdsong, household sounds) is
// silent while nobody is talking. No extra model runs: the gate costs one
// comparison per frame and one multiply per sample.
//
// Pure (no Web Audio): the AudioWorklet (media/noise-worklet.ts) only feeds
// render quanta through GatedDenoiser, so the buffering and gate logic are
// unit-tested with a fake denoiser.

// Registered name of the AudioWorkletProcessor. Lives here (not in the worklet
// module) because importing the worklet on the main thread would run its
// registerProcessor() call.
export const NOISE_WORKLET_NAME = 'engawa-rnnoise-gate';

// RNNoise works on 480-sample frames: 10ms at 48kHz.
export const RNNOISE_FRAME = 480;

// The gate opens as soon as one frame looks like speech (fast, so the start of
// a word isn't lost) and, once open, treats anything above the lower close
// threshold as still speaking. Two thresholds keep a voice hovering around one
// value from chattering the gate open/shut.
export const GATE_OPEN_VAD = 0.6;
export const GATE_CLOSE_VAD = 0.3;
// After the voice drops below the close threshold, stay open this many frames
// (300ms) so word endings and short pauses mid-sentence aren't cut.
export const GATE_HOLD_FRAMES = 30;

// Gain ramps, so opening/closing never clicks: a quick fade-in, a gentler
// fade-out.
export const GATE_ATTACK_SAMPLES = 240; // 5ms
export const GATE_RELEASE_SAMPLES = 2_880; // 60ms

// Extra output delay, in frames, beyond the one frame the 480-vs-128 buffering
// needs anyway. The gate decides on the newest frame but is applied to audio
// that is this much older, i.e. it opens slightly *before* the first speech
// frame comes out — a lookahead that keeps soft word onsets. RNNoise's voice
// probability needs a frame or two of speech to rise, so with one frame of
// lookahead the first ~10ms of a word came out softened; two keep it intact.
// Buffering latency: (1 + LOOKAHEAD) × 10ms = 30ms (~19ms more than the old
// worklet's).
export const GATE_LOOKAHEAD_FRAMES = 2;

export type GateState = { open: boolean; hold: number };

export const GATE_CLOSED: GateState = { open: false, hold: 0 };

// Pure: advance the gate by one frame given that frame's voice probability.
export function nextGate(state: GateState, vad: number): GateState {
  if (vad >= GATE_OPEN_VAD) return { open: true, hold: GATE_HOLD_FRAMES };
  if (!state.open) return state;
  if (vad >= GATE_CLOSE_VAD) return { open: true, hold: GATE_HOLD_FRAMES };
  const hold = state.hold - 1;
  return hold > 0 ? { open: true, hold } : GATE_CLOSED;
}

// Denoise one RNNOISE_FRAME-long frame of [-1, 1] samples in place and return
// its voice probability (0..1).
export type DenoiseFrame = (frame: Float32Array) => number;

// Ring capacity: comfortably above the primed delay plus one frame and one
// render quantum. Power of two for cheap wrap-around.
const RING_SIZE = 4096;

// Re-blocks the AudioWorklet's 128-sample render quanta into RNNoise frames,
// denoises them, and gates the result by the voice probability. Mono.
export class GatedDenoiser {
  private frame = new Float32Array(RNNOISE_FRAME);
  private frameLen = 0;
  private ring = new Float32Array(RING_SIZE);
  private readPos = 0;
  private writePos: number;
  private gate: GateState = GATE_CLOSED;
  private gain = 0;

  constructor(private denoise: DenoiseFrame) {
    // Prime the output with silence: one frame so a 128-sample read never runs
    // ahead of the 480-sample frames, plus the lookahead.
    this.writePos = RNNOISE_FRAME * (1 + GATE_LOOKAHEAD_FRAMES);
  }

  get isOpen() {
    return this.gate.open;
  }

  // Consume `input` and fill `output` (same length, at most one frame long).
  process(input: Float32Array, output: Float32Array) {
    for (let i = 0; i < input.length; i++) {
      this.frame[this.frameLen++] = input[i];
      if (this.frameLen === RNNOISE_FRAME) this.flushFrame();
    }
    const target = this.gate.open ? 1 : 0;
    const step = target > this.gain ? 1 / GATE_ATTACK_SAMPLES : 1 / GATE_RELEASE_SAMPLES;
    for (let i = 0; i < output.length; i++) {
      if (this.gain < target) this.gain = Math.min(target, this.gain + step);
      else if (this.gain > target) this.gain = Math.max(target, this.gain - step);
      // The priming guarantees the ring never runs dry; reading past the write
      // position would only ever yield zeros (it is cleared as it's read).
      const pos = this.readPos & (RING_SIZE - 1);
      output[i] = this.ring[pos] * this.gain;
      this.ring[pos] = 0;
      this.readPos++;
    }
  }

  private flushFrame() {
    const vad = this.denoise(this.frame);
    this.gate = nextGate(this.gate, vad);
    for (let i = 0; i < RNNOISE_FRAME; i++) {
      this.ring[(this.writePos + i) & (RING_SIZE - 1)] = this.frame[i];
    }
    this.writePos += RNNOISE_FRAME;
    this.frameLen = 0;
  }
}
