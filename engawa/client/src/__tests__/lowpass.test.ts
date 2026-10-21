import { describe, expect, it } from 'bun:test';
import { LOWPASS_HZ, LowpassFilter } from '@/media/lowpass';

const RATE = 48_000;

// Steady-state gain of the filter for a sine at `hz`: run a second of it in
// 480-sample frames (as the worklet does) and compare the last 10ms's peaks.
function gainAt(hz: number) {
  const f = new LowpassFilter(RATE);
  let inPeak = 0;
  let outPeak = 0;
  for (let frame = 0; frame < 100; frame++) {
    const buf = new Float32Array(480);
    for (let i = 0; i < buf.length; i++)
      buf[i] = Math.sin((2 * Math.PI * hz * (frame * 480 + i)) / RATE);
    const input = buf.slice();
    f.process(buf);
    if (frame === 99) {
      inPeak = Math.max(...input.map(Math.abs));
      outPeak = Math.max(...buf.map(Math.abs));
    }
  }
  return outPeak / inPeak;
}

const db = (g: number) => 20 * Math.log10(g);

describe('LowpassFilter', () => {
  it('passes the speech band untouched', () => {
    for (const hz of [200, 1_000, 3_000]) expect(Math.abs(db(gainAt(hz)))).toBeLessThan(0.2);
  });

  it('is -3dB at the cutoff', () => {
    expect(db(gainAt(LOWPASS_HZ))).toBeCloseTo(-3, 0);
  });

  it('keeps the upper voice band', () => {
    expect(db(gainAt(5_000))).toBeGreaterThan(-0.5);
  });

  it('cuts a whine just above the cutoff hard', () => {
    // A coil whine measured on a real PC's built-in mic.
    expect(db(gainAt(8_350))).toBeLessThan(-12);
    expect(db(gainAt(10_000))).toBeLessThan(-25);
    expect(db(gainAt(12_000))).toBeLessThan(-40);
  });
});
