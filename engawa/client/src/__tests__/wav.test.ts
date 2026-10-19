import { describe, expect, it } from 'bun:test';
import { downsample, encodeWav, TRANSCRIBE_SAMPLE_RATE } from '@/media/wav';

// Audio encoding for Groq Whisper: 16kHz mono 16-bit WAV.

describe('downsample', () => {
  it('reduces 48kHz to 16kHz by averaging every three samples', () => {
    const input = new Float32Array([0, 0.3, 0.6, 1, 1, 1]);
    const out = downsample(input, 48_000, 16_000);
    expect(out.length).toBe(2);
    expect(out[0]).toBeCloseTo(0.3, 5);
    expect(out[1]).toBeCloseTo(1, 5);
  });

  it('handles the non-integer ratio of a 44.1kHz device', () => {
    const input = new Float32Array(441).fill(0.5);
    const out = downsample(input, 44_100, 16_000);
    expect(out.length).toBe(160);
    for (const v of out) expect(v).toBeCloseTo(0.5, 5);
  });

  it('leaves audio alone when it is already at or below the target rate', () => {
    const input = new Float32Array([0.1, 0.2]);
    expect(downsample(input, 16_000, 16_000)).toBe(input);
    expect(downsample(input, 8_000, 16_000)).toBe(input);
  });

  it('never reads past the end of the input', () => {
    // 10 samples at a ratio of 3 leaves a partial final window.
    const out = downsample(new Float32Array(10).fill(1), 48_000, 16_000);
    for (const v of out) expect(Number.isFinite(v)).toBe(true);
  });
});

describe('encodeWav', () => {
  const header = (buf: ArrayBuffer) => String.fromCharCode(...new Uint8Array(buf, 0, 4));

  it('writes a RIFF/WAVE header with the right sizes', () => {
    const buf = encodeWav(new Float32Array(100), TRANSCRIBE_SAMPLE_RATE);
    const view = new DataView(buf);
    expect(header(buf)).toBe('RIFF');
    expect(String.fromCharCode(...new Uint8Array(buf, 8, 4))).toBe('WAVE');
    expect(buf.byteLength).toBe(44 + 200);
    expect(view.getUint32(4, true)).toBe(36 + 200); // RIFF chunk size
    expect(view.getUint16(20, true)).toBe(1); // PCM
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(16_000);
    expect(view.getUint32(28, true)).toBe(32_000); // byte rate
    expect(view.getUint16(34, true)).toBe(16); // bits per sample
    expect(view.getUint32(40, true)).toBe(200); // data size
  });

  it('scales samples to the full int16 range', () => {
    const buf = encodeWav(new Float32Array([0, 1, -1]));
    const view = new DataView(buf);
    expect(view.getInt16(44, true)).toBe(0);
    expect(view.getInt16(46, true)).toBe(32_767);
    expect(view.getInt16(48, true)).toBe(-32_768);
  });

  it('clamps out-of-range samples instead of letting them wrap', () => {
    const buf = encodeWav(new Float32Array([2.5, -2.5]));
    const view = new DataView(buf);
    expect(view.getInt16(44, true)).toBe(32_767);
    expect(view.getInt16(46, true)).toBe(-32_768);
  });

  it('produces a valid, empty file for silence of zero length', () => {
    const buf = encodeWav(new Float32Array(0));
    expect(buf.byteLength).toBe(44);
    expect(header(buf)).toBe('RIFF');
  });
});
