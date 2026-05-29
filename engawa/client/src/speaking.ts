// Speaking detection via the Web Audio AnalyserNode. A detector taps a
// MediaStream's audio track and reports whether the average frequency
// amplitude crosses a threshold, used to highlight talking participants.

const SPEAKING_THRESHOLD = 15; // RMS amplitude (0-255 scale) to count as "speaking"
const SPEAKING_SMOOTHING = 0.85; // FFT smoothing

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
  return { ctx, analyser, source, buf: new Uint8Array(analyser.frequencyBinCount) as Uint8Array<ArrayBuffer> };
}

export function isSpeaking(det: SpeakingDetector): boolean {
  det.analyser.getByteFrequencyData(det.buf);
  let sum = 0;
  for (let i = 0; i < det.buf.length; i++) sum += det.buf[i];
  return sum / det.buf.length > SPEAKING_THRESHOLD;
}

export function destroySpeakingDetector(det: SpeakingDetector) {
  det.source.disconnect();
  void det.ctx.close();
}
