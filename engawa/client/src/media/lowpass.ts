// Low-pass filter for the denoised mic (media/voice-gate.ts). Some PCs leak a
// high-pitched electrical whine (coil whine) into their built-in mic. RNNoise
// lets it through with the voice — the gate is open then — so it comes out as
// a glassy ringing riding on speech. Speech intelligibility lives below ~4kHz
// and 7kHz is the top of the "HD voice" (wideband) band, so cutting above it
// removes the whine while the voice barely changes.
//
// Pure (no Web Audio): an 8th-order Butterworth as four cascaded biquads
// (48dB/octave). Whines sit just above the cutoff (one measured at 8.35kHz),
// where a 4th-order filter at 8kHz only took 4dB off; this one takes ~15dB.
// Coefficients from the RBJ Audio EQ Cookbook.

export const LOWPASS_HZ = 7_000;

// Per-stage Q of an 8th-order Butterworth: 1 / (2·cos(kπ/16)) for k = 1, 3, 5, 7.
const BUTTERWORTH_Q8 = [0.5097956, 0.6013449, 0.8999762, 2.5629154];

type Biquad = {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
  z1: number;
  z2: number;
};

function lowpassStage(cutoff: number, sampleRate: number, q: number): Biquad {
  const w0 = (2 * Math.PI * cutoff) / sampleRate;
  const cos = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * q);
  const a0 = 1 + alpha;
  const b0 = (1 - cos) / 2 / a0;
  return { b0, b1: 2 * b0, b2: b0, a1: (-2 * cos) / a0, a2: (1 - alpha) / a0, z1: 0, z2: 0 };
}

export class LowpassFilter {
  private stages: Biquad[];

  constructor(sampleRate: number, cutoff = LOWPASS_HZ) {
    this.stages = BUTTERWORTH_Q8.map((q) => lowpassStage(cutoff, sampleRate, q));
  }

  // Filter `buf` in place (transposed direct form II; state carries across calls).
  process(buf: Float32Array) {
    for (const s of this.stages) {
      for (let i = 0; i < buf.length; i++) {
        const x = buf[i];
        const y = s.b0 * x + s.z1;
        s.z1 = s.b1 * x - s.a1 * y + s.z2;
        s.z2 = s.b2 * x - s.a2 * y;
        buf[i] = y;
      }
    }
  }
}
