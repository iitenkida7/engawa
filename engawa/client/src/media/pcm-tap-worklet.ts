// AudioWorklet processor that taps an audio stream for speech-to-text: it
// accumulates fixed blocks of mono samples and posts them to the main thread
// with their loudness, where media/segmenter.ts assembles them into utterances.
//
// Bundled as its own script by Vite (`?worker&url` in media/transcriber.ts) and
// loaded with audioWorklet.addModule, so it must never be imported on the main
// thread. It only listens — the output is left silent and the node is connected
// through a muted gain, since a worklet whose output reaches nothing is not
// guaranteed to be pulled at all.

import { BLOCK_MS, PCM_TAP_WORKLET_NAME, rms } from '@/media/segmenter';

// AudioWorkletGlobalScope members (not in TypeScript's DOM lib).
declare const sampleRate: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(name: string, ctor: unknown): void;

export type PcmBlockMessage = { samples: Float32Array; rms: number };

class PcmTapProcessor extends AudioWorkletProcessor {
  private readonly blockSize = Math.round((sampleRate * BLOCK_MS) / 1000);
  private buf = new Float32Array(this.blockSize);
  private filled = 0;
  private stopped = false;

  constructor() {
    super();
    this.port.onmessage = (e) => {
      if (e.data === 'destroy') this.stopped = true;
    };
  }

  process(inputs: Float32Array[][]) {
    const input = inputs[0]?.[0];
    // No input connected yet (or the track ended): stay alive and wait.
    if (!input) return !this.stopped;
    let read = 0;
    while (read < input.length) {
      const take = Math.min(this.blockSize - this.filled, input.length - read);
      this.buf.set(input.subarray(read, read + take), this.filled);
      this.filled += take;
      read += take;
      if (this.filled === this.blockSize) {
        const samples = this.buf;
        // Hand the buffer over rather than copying it, and start a fresh one —
        // a transferred ArrayBuffer is detached and can't be reused here.
        this.port.postMessage({ samples, rms: rms(samples) } satisfies PcmBlockMessage, [
          samples.buffer,
        ]);
        this.buf = new Float32Array(this.blockSize);
        this.filled = 0;
      }
    }
    return !this.stopped;
  }
}

registerProcessor(PCM_TAP_WORKLET_NAME, PcmTapProcessor);
