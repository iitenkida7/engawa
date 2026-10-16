// AudioWorklet processor for mic noise suppression: RNNoise denoising plus the
// voice gate (media/voice-gate.ts). Bundled as its own script by Vite
// (`?worker&url` in media/noise.ts) and loaded with audioWorklet.addModule, so
// it must never be imported on the main thread.
//
// Protocol: processorOptions.wasmBinary carries the RNNoise WASM; the processor
// posts 'ready' once it's instantiated or { error } if that fails, so the caller
// can fall back to the raw mic instead of sending silence.

import { createRnnoise } from '@/media/rnnoise-wasm';
import { GatedDenoiser, NOISE_WORKLET_NAME } from '@/media/voice-gate';

// AudioWorkletGlobalScope members (not in TypeScript's DOM lib).
declare const sampleRate: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(name: string, ctor: unknown): void;

type Options = { processorOptions: { wasmBinary: ArrayBuffer } };

class RnnoiseGateProcessor extends AudioWorkletProcessor {
  private denoiser: GatedDenoiser | null = null;
  private destroy: (() => void) | null = null;
  private destroyed = false;

  constructor(options: Options) {
    super();
    this.port.onmessage = (e) => {
      if (e.data === 'destroy') this.teardown();
    };
    void this.init(options.processorOptions.wasmBinary);
  }

  private async init(wasm: ArrayBuffer) {
    try {
      if (sampleRate !== 48_000) throw new Error(`unsupported sample rate ${sampleRate}`);
      const rnnoise = await createRnnoise(wasm);
      if (this.destroyed) {
        rnnoise.destroy();
        return;
      }
      this.denoiser = new GatedDenoiser(rnnoise.processFrame);
      this.destroy = rnnoise.destroy;
      this.port.postMessage('ready');
    } catch (err) {
      this.port.postMessage({ error: String(err) });
    }
  }

  private teardown() {
    this.destroyed = true;
    this.denoiser = null;
    this.destroy?.();
    this.destroy = null;
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]) {
    const input = inputs[0]?.[0];
    const output = outputs[0]?.[0];
    // Outputs start zeroed, so until the WASM is ready (or with no input
    // connected) this emits silence.
    if (input && output && this.denoiser) this.denoiser.process(input, output);
    return !this.destroyed;
  }
}

registerProcessor(NOISE_WORKLET_NAME, RnnoiseGateProcessor);
