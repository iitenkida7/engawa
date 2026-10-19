import { describe, expect, it } from 'bun:test';
import { createRnnoise } from '@/media/rnnoise-wasm';
import { RNNOISE_FRAME } from '@/media/voice-gate';

// The same WASM build media/noise.ts ships to the browser.
async function loadWasm() {
  const path = Bun.resolveSync('@sapphi-red/web-noise-suppressor/rnnoise.wasm', import.meta.dir);
  return Bun.file(path).arrayBuffer();
}

// Deterministic white noise in [-amp, amp].
function noiseFrame(seed: number, amp: number) {
  const f = new Float32Array(RNNOISE_FRAME);
  let x = seed;
  for (let i = 0; i < f.length; i++) {
    x = (x * 1103515245 + 12345) % 2147483648;
    f[i] = (x / 2147483648 - 0.5) * 2 * amp;
  }
  return f;
}

const energy = (f: Float32Array) => f.reduce((s, v) => s + v * v, 0);

describe('createRnnoise', () => {
  it('denoises steady noise and reports a low voice probability', async () => {
    const rn = await createRnnoise(await loadWasm());
    let lastIn = 0;
    let lastOut = 0;
    let lastVad = 1;
    // Let the model settle on the noise floor for a second.
    for (let i = 0; i < 100; i++) {
      const f = noiseFrame(i + 1, 0.05);
      lastIn = energy(f);
      lastVad = rn.processFrame(f);
      lastOut = energy(f);
    }
    expect(lastVad).toBeGreaterThanOrEqual(0);
    expect(lastVad).toBeLessThan(0.3);
    expect(lastOut).toBeLessThan(lastIn * 0.1);
    rn.destroy();
  });

  it('rejects a frame of the wrong size and use after destroy', async () => {
    const rn = await createRnnoise(await loadWasm());
    expect(() => rn.processFrame(new Float32Array(128))).toThrow();
    rn.destroy();
    expect(() => rn.processFrame(new Float32Array(RNNOISE_FRAME))).toThrow();
  });
});
