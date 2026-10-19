// Audio encoding for speech-to-text: turn raw Web Audio samples into the format
// Whisper wants (16kHz mono 16-bit WAV).
//
// Why not reuse MediaRecorder (media/recorder.ts)? Its output is a *stream* of
// WebM chunks where only the first carries the container header, so an
// individual chunk can't be decoded on its own — exactly what we'd need to POST
// a rolling window to the API. Encoding PCM ourselves sidesteps that entirely:
// every window is a self-contained file, the boundaries are ours to choose, and
// downsampling 48kHz → 16kHz cuts the upload to a third with no loss that
// matters to speech recognition (Whisper resamples to 16kHz internally anyway).
//
// Both functions are pure so they can be unit-tested without an AudioContext.

// Whisper's native rate. Sending anything higher just wastes bandwidth.
export const TRANSCRIBE_SAMPLE_RATE = 16_000;

const WAV_HEADER_BYTES = 44;
const BITS_PER_SAMPLE = 16;
const PCM_FORMAT = 1;
// Int16 range: negative values reach one step further than positive ones.
const INT16_MIN = -32_768;
const INT16_MAX = 32_767;

// Resample to 16kHz by averaging each source window into one output sample.
// A box filter is crude as filters go, but it doubles as the anti-alias
// low-pass the decimation needs, and speech lives well below the 8kHz Nyquist
// limit that survives. Handles non-integer ratios (44.1kHz devices) too.
export function downsample(
  input: Float32Array,
  inputRate: number,
  outputRate = TRANSCRIBE_SAMPLE_RATE,
): Float32Array {
  if (inputRate <= outputRate) return input;
  const ratio = inputRate / outputRate;
  const outLength = Math.floor(input.length / ratio);
  const out = new Float32Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const start = Math.floor(i * ratio);
    // Guard the tail: the last window can run past the input on fractional ratios.
    const end = Math.min(Math.floor((i + 1) * ratio), input.length);
    let sum = 0;
    for (let j = start; j < end; j++) sum += input[j];
    out[i] = end > start ? sum / (end - start) : 0;
  }
  return out;
}

// Wrap mono float samples (-1..1) in a RIFF/WAVE container as 16-bit PCM.
export function encodeWav(samples: Float32Array, sampleRate = TRANSCRIBE_SAMPLE_RATE): ArrayBuffer {
  const buffer = new ArrayBuffer(WAV_HEADER_BYTES + samples.length * 2);
  const view = new DataView(buffer);
  const byteRate = sampleRate * (BITS_PER_SAMPLE / 8);
  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, WAV_HEADER_BYTES - 8 + samples.length * 2, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, PCM_FORMAT, true);
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, BITS_PER_SAMPLE / 8, true); // block align
  view.setUint16(34, BITS_PER_SAMPLE, true);
  writeAscii(view, 36, 'data');
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    // Clamp before scaling: a sample over 1.0 (gain stacking) would otherwise
    // wrap around to full-scale noise of the opposite sign.
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(
      WAV_HEADER_BYTES + i * 2,
      Math.round(clamped * (clamped < 0 ? -INT16_MIN : INT16_MAX)),
      true,
    );
  }
  return buffer;
}

function writeAscii(view: DataView, offset: number, text: string) {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
}
