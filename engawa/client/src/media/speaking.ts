// Speaking detection via the Web Audio AnalyserNode.
//
// A detector taps an audio stream and, frame by frame, decides whether the
// speaker is currently talking. The decision is intentionally crude (average
// frequency magnitude over a threshold) — enough to drive the "speaking" ring
// around an avatar/tile without any heavy DSP. The pure threshold math is split
// out (`isLoud`) so it can be unit-tested without a real AudioContext.

// Average frequency magnitude (0-255 scale) above which a frame counts as
// "speaking".
const SPEAKING_THRESHOLD = 15;
// Analyser FFT smoothing — higher values steady the reading across frames.
const SPEAKING_SMOOTHING = 0.85;

export type SpeakingDetector = {
  analyser: AnalyserNode;
  source: MediaStreamAudioSourceNode;
  buf: Uint8Array<ArrayBuffer>;
};

// One AudioContext shared by every detector. A 5-person SFU group would otherwise
// open ~6-8 contexts (one per remote mic + local + recorder), a range where
// browsers cap/throw. Also resumed on each use: a context created while the
// autoplay gate is closed starts 'suspended' and reads all-zero frequency data,
// so the speaking ring would silently never light (recorder.ts does the same).
let sharedCtx: AudioContext | null = null;
function getSharedAudioContext(): AudioContext {
  if (!sharedCtx) sharedCtx = new AudioContext();
  if (sharedCtx.state === 'suspended') void sharedCtx.resume();
  return sharedCtx;
}

export function createSpeakingDetector(stream: MediaStream): SpeakingDetector | null {
  const audioTrack = stream.getAudioTracks()[0];
  if (!audioTrack) return null;
  const ctx = getSharedAudioContext();
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 256;
  analyser.smoothingTimeConstant = SPEAKING_SMOOTHING;
  const source = ctx.createMediaStreamSource(stream);
  source.connect(analyser);
  // Don't connect to destination — we only analyse, not play.
  return {
    analyser,
    source,
    buf: new Uint8Array(analyser.frequencyBinCount) as Uint8Array<ArrayBuffer>,
  };
}

// Pure: averages the frequency bins and compares against the threshold. Split
// from the analyser read so it can be unit-tested without Web Audio.
export function isLoud(buf: Uint8Array): boolean {
  if (buf.length === 0) return false;
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i];
  return sum / buf.length > SPEAKING_THRESHOLD;
}

export function isSpeaking(det: SpeakingDetector): boolean {
  det.analyser.getByteFrequencyData(det.buf);
  return isLoud(det.buf);
}

export function destroySpeakingDetector(det: SpeakingDetector) {
  // Disconnect just this detector's nodes; the AudioContext is shared, so it is
  // NOT closed here (it lives for the page, like the sound-effects context).
  det.source.disconnect();
  det.analyser.disconnect();
}
