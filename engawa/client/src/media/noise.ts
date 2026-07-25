// Microphone noise suppression: strip background noise (keyboards, fans, room
// tone) from the outgoing mic before it reaches any peer.
//
// The heavy lifting runs entirely in the browser via RNNoise (a small neural
// denoiser) compiled to WASM, driven from an AudioWorklet
// (@sapphi-red/web-noise-suppressor). The WASM is bundled locally — no CDN, no
// external request — so both the mic audio and the model stay on the device.
// Media never touches our own server (invariant #1).
//
// The class wraps a raw mic MediaStream and exposes a processed one from a
// MediaStreamAudioDestinationNode, so `media.ts` can swap it in for `micStream`
// and every downstream path (mesh/SFU send, speaking detection, recording) gets
// the cleaned audio for free — mirroring how VirtualBackground wraps the camera.

import { loadRnnoise, RnnoiseWorkletNode } from '@sapphi-red/web-noise-suppressor';
import rnnoiseWasmUrl from '@sapphi-red/web-noise-suppressor/rnnoise.wasm?url';
import rnnoiseSimdWasmUrl from '@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url';
import rnnoiseWorkletUrl from '@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url';

// RNNoise assumes 48kHz. Force the context so the mic stream is resampled to
// match rather than fed at the device's native rate (often 44.1kHz).
const RNNOISE_SAMPLE_RATE = 48_000;

// The WASM binary is fetched once and reused across enable/disable cycles.
let wasmBinaryPromise: Promise<ArrayBuffer> | null = null;
function loadWasm(): Promise<ArrayBuffer> {
  wasmBinaryPromise ??= loadRnnoise({ url: rnnoiseWasmUrl, simdUrl: rnnoiseSimdWasmUrl });
  return wasmBinaryPromise;
}

export class NoiseSuppressor {
  private ctx: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private node: RnnoiseWorkletNode | null = null;
  private dest: MediaStreamAudioDestinationNode | null = null;

  constructor(private srcStream: MediaStream) {}

  // Lifecycle: construct → start() (async; may throw if the WASM/worklet can't
  // load) → stop(). On failure the caller falls back to the raw mic so audio
  // still works.
  async start(): Promise<MediaStream> {
    const wasmBinary = await loadWasm();
    const ctx = new AudioContext({ sampleRate: RNNOISE_SAMPLE_RATE });
    if (ctx.state === 'suspended') await ctx.resume();
    await ctx.audioWorklet.addModule(rnnoiseWorkletUrl);
    const source = ctx.createMediaStreamSource(this.srcStream);
    const node = new RnnoiseWorkletNode(ctx, { maxChannels: 1, wasmBinary });
    const dest = ctx.createMediaStreamDestination();
    source.connect(node).connect(dest);
    this.ctx = ctx;
    this.source = source;
    this.node = node;
    this.dest = dest;
    return dest.stream;
  }

  stop() {
    try {
      this.node?.destroy();
    } catch {
      /* already torn down */
    }
    this.source?.disconnect();
    this.node?.disconnect();
    this.dest?.disconnect();
    if (this.ctx) void this.ctx.close();
    this.ctx = null;
    this.source = null;
    this.node = null;
    this.dest = null;
  }
}
