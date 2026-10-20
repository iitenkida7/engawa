import { describe, expect, it } from 'bun:test';
import {
  DRY_MIX,
  GATE_ATTACK_SAMPLES,
  GATE_CLOSE_VAD,
  GATE_CLOSED,
  GATE_HOLD_FRAMES,
  GATE_LOOKAHEAD_FRAMES,
  GATE_OPEN_VAD,
  GATE_RELEASE_SAMPLES,
  GatedDenoiser,
  nextGate,
  RNNOISE_FRAME,
} from '@/media/voice-gate';

describe('nextGate', () => {
  it('opens on one speech-like frame', () => {
    expect(nextGate(GATE_CLOSED, GATE_OPEN_VAD)).toEqual({ open: true, hold: GATE_HOLD_FRAMES });
  });

  it('stays closed for noise below the open threshold', () => {
    // Between the thresholds is not enough to open a closed gate (hysteresis).
    expect(nextGate(GATE_CLOSED, (GATE_OPEN_VAD + GATE_CLOSE_VAD) / 2)).toBe(GATE_CLOSED);
    expect(nextGate(GATE_CLOSED, 0)).toBe(GATE_CLOSED);
  });

  it('keeps an open gate open while above the close threshold', () => {
    const open = { open: true, hold: 3 };
    expect(nextGate(open, GATE_CLOSE_VAD)).toEqual({ open: true, hold: GATE_HOLD_FRAMES });
  });

  it('closes only after the hold runs out', () => {
    let s = nextGate(GATE_CLOSED, 1);
    for (let i = 0; i < GATE_HOLD_FRAMES - 1; i++) {
      s = nextGate(s, 0);
      expect(s.open).toBe(true);
    }
    expect(nextGate(s, 0)).toBe(GATE_CLOSED);
  });
});

// Identity "denoiser" that reports a scripted voice probability per frame.
function scripted(vads: number[]) {
  let i = 0;
  return (_frame: Float32Array) => vads[i++] ?? 0;
}

// Feed `frames` frames of a constant signal through in 128-sample quanta and
// return everything that came out.
function run(d: GatedDenoiser, frames: number, value = 0.5) {
  const total = frames * RNNOISE_FRAME;
  const out = new Float32Array(total);
  const quantum = 128;
  for (let pos = 0; pos < total; pos += quantum) {
    const n = Math.min(quantum, total - pos);
    const input = new Float32Array(n).fill(value);
    d.process(input, out.subarray(pos, pos + n));
  }
  return out;
}

const LATENCY = RNNOISE_FRAME * (1 + GATE_LOOKAHEAD_FRAMES);

// The gate tests pass dryMix 0 so the output is exactly the gated denoiser output.
describe('GatedDenoiser', () => {
  it('mutes noise completely while nobody speaks', () => {
    const out = run(new GatedDenoiser(scripted([]), 0), 20);
    expect(out.every((v) => v === 0)).toBe(true);
  });

  it('passes speech through after the fixed latency', () => {
    const out = run(new GatedDenoiser(scripted(Array(20).fill(1)), 0), 20);
    // Primed silence first…
    expect(out.subarray(0, LATENCY).every((v) => v === 0)).toBe(true);
    // …then the signal at full gain once the attack ramp is done.
    const settled = out.subarray(LATENCY + GATE_ATTACK_SAMPLES);
    expect(settled.every((v) => Math.abs(v - 0.5) < 1e-6)).toBe(true);
  });

  it('opens before the first speech frame comes out (lookahead)', () => {
    // 5 noise frames, then speech.
    const vads = [0, 0, 0, 0, 0, 1, 1, 1, 1, 1];
    const out = run(new GatedDenoiser(scripted(vads), 0), 10);
    // The first speech frame's samples leave at its input position + latency;
    // the gate (decided when that frame was processed) is already fully open.
    const firstSpeechOut = 5 * RNNOISE_FRAME + LATENCY;
    expect(out[firstSpeechOut]).toBeCloseTo(0.5, 6);
    // Noise before it is still silent: the gate opened only the lookahead (plus
    // the render quantum the decision landed in) early.
    expect(out[firstSpeechOut - GATE_LOOKAHEAD_FRAMES * RNNOISE_FRAME - 128 - 1]).toBe(0);
  });

  it('holds through a short pause, then fades out without a click', () => {
    const vads = [1, ...Array(GATE_HOLD_FRAMES + 20).fill(0)];
    const d = new GatedDenoiser(scripted(vads), 0);
    const out = run(d, vads.length);
    // Still open well into the hold.
    const midHold = LATENCY + (GATE_HOLD_FRAMES / 2) * RNNOISE_FRAME;
    expect(out[midHold]).toBeCloseTo(0.5, 6);
    expect(d.isOpen).toBe(false);
    // Fully closed at the end, and the fade never jumps by more than one step.
    expect(out[out.length - 1]).toBe(0);
    for (let i = LATENCY + 1; i < out.length; i++) {
      expect(Math.abs(out[i] - out[i - 1])).toBeLessThanOrEqual(
        0.5 / Math.min(GATE_ATTACK_SAMPLES, GATE_RELEASE_SAMPLES) + 1e-6,
      );
    }
  });

  it('outputs the denoised frame, not the raw input', () => {
    const halve = (f: Float32Array) => {
      for (let i = 0; i < f.length; i++) f[i] *= 0.5;
      return 1;
    };
    const out = run(new GatedDenoiser(halve, 0), 10, 0.8);
    expect(out[out.length - 1]).toBeCloseTo(0.4, 6);
  });

  it('mixes the raw input back in, delayed one frame to match RNNoise', () => {
    // Fake denoiser that removes everything but reports speech: the output is
    // then only the dry signal, which must be the input one frame later.
    const silence = (f: Float32Array) => {
      f.fill(0);
      return 1;
    };
    const d = new GatedDenoiser(silence);
    const frames = 10;
    const total = frames * RNNOISE_FRAME;
    const input = new Float32Array(total).map((_, i) => Math.sin(i / 7));
    const out = new Float32Array(total);
    for (let pos = 0; pos < total; pos += 128) {
      const n = Math.min(128, total - pos);
      d.process(input.subarray(pos, pos + n), out.subarray(pos, pos + n));
    }
    const delay = LATENCY + RNNOISE_FRAME;
    for (let i = delay + GATE_ATTACK_SAMPLES; i < total; i++) {
      expect(out[i]).toBeCloseTo(DRY_MIX * input[i - delay], 6);
    }
  });
});
