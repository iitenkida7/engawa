// Microphone noise suppression: strip background noise (keyboards, fans, room
// tone) from the outgoing mic before it reaches any peer, and mute it outright
// between utterances (the voice gate, media/voice-gate.ts) so sounds RNNoise
// can't remove — a passing motorbike, birdsong — aren't heard while nobody talks.
//
// The heavy lifting runs entirely in the browser: RNNoise (a small neural
// denoiser) compiled to WASM, driven from our own AudioWorklet
// (media/noise-worklet.ts). The WASM is the build bundled with
// @sapphi-red/web-noise-suppressor, served locally — no CDN, no external
// request — so both the mic audio and the model stay on the device. Media never
// touches our own server (invariant #1).
//
// The class wraps a raw mic MediaStream and exposes a processed one from a
// MediaStreamAudioDestinationNode, so `media.ts` can swap it in for `micStream`
// and every downstream path (mesh/SFU send, speaking detection, recording) gets
// the cleaned audio for free — mirroring how VirtualBackground wraps the camera.

import { loadRnnoise } from '@sapphi-red/web-noise-suppressor';
import rnnoiseWasmUrl from '@sapphi-red/web-noise-suppressor/rnnoise.wasm?url';
import rnnoiseSimdWasmUrl from '@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url';
import noiseWorkletUrl from '@/media/noise-worklet?worker&url';
import { NOISE_WORKLET_NAME } from '@/media/voice-gate';

// How long to wait for the worklet to instantiate the WASM before giving up and
// falling back to the raw mic.
const READY_TIMEOUT_MS = 5_000;

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
  private node: AudioWorkletNode | null = null;
  private dest: MediaStreamAudioDestinationNode | null = null;

  constructor(private srcStream: MediaStream) {}

  // Lifecycle: construct → start() (async; may throw if the WASM/worklet can't
  // load) → stop(). On failure the caller falls back to the raw mic so audio
  // still works.
  async start(): Promise<MediaStream> {
    const wasmBinary = await loadWasm();
    const ctx = new AudioContext({ sampleRate: RNNOISE_SAMPLE_RATE });
    this.ctx = ctx;
    try {
      if (ctx.state === 'suspended') await ctx.resume();
      await ctx.audioWorklet.addModule(noiseWorkletUrl);
      const node = new AudioWorkletNode(ctx, NOISE_WORKLET_NAME, {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        // Downmix to mono before processing: one denoiser, one gate.
        channelCount: 1,
        channelCountMode: 'explicit',
        processorOptions: { wasmBinary },
      });
      this.node = node;
      await waitReady(node.port);
      const source = ctx.createMediaStreamSource(this.srcStream);
      const dest = ctx.createMediaStreamDestination();
      source.connect(node).connect(dest);
      this.source = source;
      this.dest = dest;
      return dest.stream;
    } catch (e) {
      // The caller falls back to the raw mic without calling stop().
      this.stop();
      throw e;
    }
  }

  stop() {
    this.node?.port.postMessage('destroy');
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

// Resolve once the worklet reports the WASM is ready; reject on its error or a
// timeout, so start() fails and the caller falls back to the raw mic.
function waitReady(port: MessagePort): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('noise worklet timed out')), READY_TIMEOUT_MS);
    port.onmessage = (e) => {
      clearTimeout(timer);
      port.onmessage = null;
      if (e.data === 'ready') resolve();
      else reject(new Error(`noise worklet failed: ${e.data?.error ?? 'unknown'}`));
    };
  });
}
