// Live meeting transcription.
//
// One tap per person — the local mic and every remote mic arrive as separate
// streams, so who said what falls out of the plumbing instead of needing
// speaker diarisation. Each tap feeds media/segmenter.ts, which cuts the audio
// at natural pauses; finished utterances are encoded as 16kHz WAV
// (media/wav.ts) and posted to Groq's Whisper API (media/groq.ts) straight from
// the browser, so audio still never touches our server (invariant #1).
//
// The AudioContext is the shared one (media/speaking.ts): a per-person context
// here would stack on top of the detectors and volume routes already tapping
// the same streams, and a 5-person call would hit the browser's context cap.

import { GroqAuthError, type GroqModel, transcribeAudio } from '@/media/groq';
import type { PcmBlockMessage } from '@/media/pcm-tap-worklet';
import pcmTapWorkletUrl from '@/media/pcm-tap-worklet?worker&url';
import {
  concatBlocks,
  flushSegment,
  newSegmentState,
  PCM_TAP_WORKLET_NAME,
  pushBlock,
  type SegmentState,
} from '@/media/segmenter';
import { getSharedAudioContext } from '@/media/speaking';
import { downsample, encodeWav, TRANSCRIBE_SAMPLE_RATE } from '@/media/wav';

// Lines of previous transcript fed back as context, so repeated names and
// jargon keep one spelling across segments.
const PROMPT_SEGMENTS = 3;
const PROMPT_MAX_CHARS = 300;

type Tap = {
  source: MediaStreamAudioSourceNode;
  node: AudioWorkletNode;
  // Muted sink: a worklet whose output reaches nothing is not reliably pulled,
  // so the tap is connected onward at zero gain rather than left dangling.
  sink: GainNode;
  state: SegmentState;
  streamId: string;
};

export type TranscriberOptions = {
  // Called for each recognised utterance. `at` is when the utterance started.
  onTranscript: (speakerId: string, text: string, at: number) => void;
  // Called when transcription had to stop (bad key, repeated failures).
  onError: (message: string, fatal: boolean) => void;
  getApiKey: () => string | null;
  getModel: () => GroqModel;
  getLanguage: () => string;
};

export class TranscriberManager {
  private opts: TranscriberOptions;
  private taps = new Map<string, Tap>();
  private workletLoaded = false;
  private running = false;
  // Requests are serialised: Whisper-turbo returns a 25s segment in well under
  // a second, and one queue keeps a busy call from fanning out into a burst
  // that trips the rate limit.
  private queue: Promise<void> = Promise.resolve();
  private recent: string[] = [];
  private abort: AbortController | null = null;

  constructor(opts: TranscriberOptions) {
    this.opts = opts;
  }

  get active(): boolean {
    return this.running;
  }

  // Begin transcribing. Returns false when the browser can't run the tap at all
  // (no AudioWorklet), so the caller can report it instead of showing an
  // enabled-but-dead button.
  async start(streams: { userId: string; stream: MediaStream }[]): Promise<boolean> {
    if (this.running) return true;
    try {
      await this.ensureWorklet();
    } catch (err) {
      this.opts.onError(String(err), true);
      return false;
    }
    this.running = true;
    this.abort = new AbortController();
    for (const { userId, stream } of streams) this.addStream(userId, stream);
    return true;
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    // Drop anything still queued or in flight: results arriving after the user
    // switched it off would be a surprise, and we no longer have consent.
    this.abort?.abort();
    this.abort = null;
    for (const userId of [...this.taps.keys()]) this.removeStream(userId);
    this.recent = [];
  }

  // Attach (or re-attach) one person's audio. Safe to call for a stream that is
  // already tapped — a stream swap (SFU↔mesh, device change) replaces it.
  addStream(userId: string, stream: MediaStream) {
    if (!this.running) return;
    if (!stream.getAudioTracks().length) return;
    const existing = this.taps.get(userId);
    if (existing) {
      if (existing.streamId === stream.id) return;
      this.removeStream(userId);
    }
    const ctx = getSharedAudioContext();
    try {
      const source = ctx.createMediaStreamSource(stream);
      const node = new AudioWorkletNode(ctx, PCM_TAP_WORKLET_NAME, {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        channelCount: 1,
        channelCountMode: 'explicit',
      });
      const sink = ctx.createGain();
      sink.gain.value = 0;
      source.connect(node).connect(sink).connect(ctx.destination);
      const tap: Tap = { source, node, sink, state: newSegmentState(), streamId: stream.id };
      node.port.onmessage = (e: MessageEvent<PcmBlockMessage>) => {
        this.onBlock(userId, tap, e.data);
      };
      this.taps.set(userId, tap);
    } catch (err) {
      this.opts.onError(String(err), false);
    }
  }

  removeStream(userId: string) {
    const tap = this.taps.get(userId);
    if (!tap) return;
    this.taps.delete(userId);
    // Send whatever was mid-sentence before tearing down, so a thought isn't
    // lost because someone walked out of range as they finished it.
    const action = flushSegment(tap.state);
    if (action.type === 'emit') this.enqueue(userId, concatBlocks(action.blocks), Date.now());
    tap.node.port.onmessage = null;
    tap.node.port.postMessage('destroy');
    tap.source.disconnect();
    tap.node.disconnect();
    tap.sink.disconnect();
  }

  private onBlock(userId: string, tap: Tap, block: PcmBlockMessage) {
    if (!this.running) return;
    const action = pushBlock(tap.state, block.samples, block.rms);
    if (action.type !== 'emit') return;
    const samples = concatBlocks(action.blocks);
    // Timestamp the start of the utterance, not the moment it was recognised.
    const startedAt = Date.now() - (samples.length / getSharedAudioContext().sampleRate) * 1000;
    this.enqueue(userId, samples, startedAt);
  }

  // Encode now, not when the request goes out: a queued segment then waits as
  // the 16kHz 16-bit WAV it will be sent as (about 1/6 of the 48kHz float
  // samples), held in a Blob rather than on the JS heap. A backlog while the API
  // is rate-limiting or the network is down stays small without dropping
  // anything.
  private enqueue(userId: string, samples: Float32Array, startedAt: number) {
    const signal = this.abort?.signal;
    const rate = getSharedAudioContext().sampleRate;
    const wav = new Blob([encodeWav(downsample(samples, rate), TRANSCRIBE_SAMPLE_RATE)], {
      type: 'audio/wav',
    });
    this.queue = this.queue.then(async () => {
      if (!this.running || signal?.aborted) return;
      const apiKey = this.opts.getApiKey();
      if (!apiKey) return;
      try {
        const text = await transcribeAudio(wav, {
          apiKey,
          model: this.opts.getModel(),
          language: this.opts.getLanguage(),
          prompt: this.recent.join(' ').slice(-PROMPT_MAX_CHARS) || undefined,
          signal,
        });
        if (!text || !this.running) return;
        this.recent.push(text);
        if (this.recent.length > PROMPT_SEGMENTS) this.recent.shift();
        this.opts.onTranscript(userId, text, startedAt);
      } catch (err) {
        if (signal?.aborted) return;
        const fatal = err instanceof GroqAuthError;
        this.opts.onError(err instanceof Error ? err.message : String(err), fatal);
        if (fatal) this.stop();
      }
    });
  }

  private async ensureWorklet() {
    if (this.workletLoaded) return;
    const ctx = getSharedAudioContext();
    if (!ctx.audioWorklet) throw new Error('AudioWorklet unsupported');
    await ctx.audioWorklet.addModule(pcmTapWorkletUrl);
    this.workletLoaded = true;
  }
}
