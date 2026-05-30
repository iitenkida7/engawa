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
  ctx: AudioContext;
  analyser: AnalyserNode;
  source: MediaStreamAudioSourceNode;
  buf: Uint8Array<ArrayBuffer>;
};

export function createSpeakingDetector(stream: MediaStream): SpeakingDetector | null {
  const audioTrack = stream.getAudioTracks()[0];
  if (!audioTrack) return null;
  const ctx = new AudioContext();
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 256;
  analyser.smoothingTimeConstant = SPEAKING_SMOOTHING;
  const source = ctx.createMediaStreamSource(stream);
  source.connect(analyser);
  // Don't connect to destination — we only analyse, not play.
  return {
    ctx,
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
  det.source.disconnect();
  void det.ctx.close();
}
