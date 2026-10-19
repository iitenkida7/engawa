// Minimal loader for the RNNoise WASM build shipped with
// @sapphi-red/web-noise-suppressor (Shiguredo's rnnoise-wasm). That package's
// own worklet discards the voice probability rnnoise_process_frame returns, so
// we drive the WASM directly. The module only imports three trivial Emscripten
// runtime hooks, provided below — no Emscripten JS glue needed. Runs inside the
// AudioWorklet (media/noise-worklet.ts) and in tests.

import { type DenoiseFrame, RNNOISE_FRAME } from '@/media/voice-gate';

type RnnoiseExports = {
  memory: WebAssembly.Memory;
  __wasm_call_ctors: () => void;
  emscripten_stack_init?: () => void;
  rnnoise_get_frame_size: () => number;
  rnnoise_create: (model: number) => number;
  rnnoise_destroy: (state: number) => void;
  rnnoise_process_frame: (state: number, out: number, input: number) => number;
  malloc: (size: number) => number;
  free: (ptr: number) => void;
};

export type Rnnoise = {
  // Denoise a frame of [-1, 1] samples in place; returns the voice probability.
  processFrame: DenoiseFrame;
  destroy: () => void;
};

// RNNoise expects 16-bit PCM magnitudes.
const PCM_SCALE = 32767;

export async function createRnnoise(wasm: BufferSource): Promise<Rnnoise> {
  let memory: WebAssembly.Memory | null = null;
  const env = {
    emscripten_memcpy_big: (dest: number, src: number, num: number) => {
      new Uint8Array((memory as WebAssembly.Memory).buffer).copyWithin(dest, src, src + num);
    },
    emscripten_resize_heap: (requested: number) => {
      const mem = memory as WebAssembly.Memory;
      const needed = (requested >>> 0) - mem.buffer.byteLength;
      if (needed <= 0) return 1;
      try {
        mem.grow(Math.ceil(needed / 65536));
        return 1;
      } catch {
        return 0;
      }
    },
    __assert_fail: () => {
      throw new Error('rnnoise: assertion failed');
    },
  };
  const module = await WebAssembly.compile(wasm);
  const instance = await WebAssembly.instantiate(module, {
    env,
    wasi_snapshot_preview1: env,
  });
  const ex = instance.exports as unknown as RnnoiseExports;
  memory = ex.memory;
  ex.emscripten_stack_init?.();
  ex.__wasm_call_ctors();

  if (ex.rnnoise_get_frame_size() !== RNNOISE_FRAME) {
    throw new Error(`rnnoise: unexpected frame size ${ex.rnnoise_get_frame_size()}`);
  }
  const state = ex.rnnoise_create(0); // 0 = built-in model
  const inPtr = ex.malloc(RNNOISE_FRAME * 4);
  const outPtr = ex.malloc(RNNOISE_FRAME * 4);
  if (!state || !inPtr || !outPtr) throw new Error('rnnoise: allocation failed');

  // A heap growth detaches the old buffer, so re-take the view when it changes.
  let heap = new Float32Array(memory.buffer);
  let destroyed = false;

  return {
    processFrame(frame) {
      if (destroyed) throw new Error('rnnoise: already destroyed');
      if (frame.length !== RNNOISE_FRAME) {
        throw new Error(`rnnoise: expected ${RNNOISE_FRAME} samples, got ${frame.length}`);
      }
      const mem = memory as WebAssembly.Memory;
      if (heap.buffer !== mem.buffer) heap = new Float32Array(mem.buffer);
      const inIdx = inPtr >> 2;
      for (let i = 0; i < RNNOISE_FRAME; i++) heap[inIdx + i] = frame[i] * PCM_SCALE;
      const vad = ex.rnnoise_process_frame(state, outPtr, inPtr);
      if (heap.buffer !== mem.buffer) heap = new Float32Array(mem.buffer);
      const outIdx = outPtr >> 2;
      for (let i = 0; i < RNNOISE_FRAME; i++) frame[i] = heap[outIdx + i] / PCM_SCALE;
      return vad;
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      ex.rnnoise_destroy(state);
      ex.free(inPtr);
      ex.free(outPtr);
    },
  };
}
