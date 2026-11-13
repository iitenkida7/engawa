// Tiny WebAudio-synthesized chimes for proximity in/out. No assets.
//
// The AudioContext is created lazily on the first chime so that the user's
// initial gesture (clicking 入室) counts as activation — without that, browsers
// suspend the context and the first sound is silent.
//
// Every chime goes through one shared bus (a master gain into a compressor that
// acts as a limiter) and enter/leave chimes are rate-limited (ui/sound-limit.ts),
// so a crowd walking in or out together can't stack up past full scale and crackle.

import { admitChime } from '@/ui/sound-limit';

export class SoundManager {
  private ctx: AudioContext | null = null;
  // Shared output stage: all notes feed this instead of ctx.destination.
  private bus: AudioNode | null = null;
  // Start times of the recent enter/leave chimes (see admitChime).
  private recentChimes: number[] = [];

  private getCtx(): AudioContext {
    if (!this.ctx) {
      const Ctor =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new Ctor();
      this.bus = this.createBus(this.ctx);
    }
    // Some browsers leave the context suspended until a gesture; resume on each play.
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    return this.ctx;
  }

  // Master gain → compressor (set up as a limiter) → speakers. Several chimes at
  // once are squeezed instead of summed into clipping.
  private createBus(ctx: AudioContext): AudioNode {
    const master = ctx.createGain();
    master.gain.value = 0.8;
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -18;
    limiter.knee.value = 12;
    limiter.ratio.value = 12;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.25;
    master.connect(limiter).connect(ctx.destination);
    return master;
  }

  // Whether an enter/leave chime may start now (a burst is thinned out). The
  // knock is exempt: someone is calling you, and it is rare.
  private admit(): boolean {
    const r = admitChime(this.recentChimes, performance.now());
    this.recentChimes = r.history;
    return r.ok;
  }

  // Rising 2-note chime when someone enters the call range.
  enter() {
    if (!this.admit()) return;
    this.playSequence([523.25, 783.99], 0.08, 0.18); // C5 → G5
  }

  // Falling 2-note chime when someone leaves.
  leave() {
    if (!this.admit()) return;
    this.playSequence([783.99, 523.25], 0.08, 0.12); // G5 → C5
  }

  // Two-tone doorbell "ピンポン" for an incoming knock (someone is calling you) —
  // longer, bell-like notes so it's clearly distinct from the enter/leave chimes.
  knock() {
    // Relaxed change (gap 0.24) with a long ring (0.9), so the two notes overlap
    // into a slow, sustained ding-dong. A bell-like overtone stack (fundamental +
    // octave + fifth-above + two-octave) gives it body instead of a pure beep.
    this.playSequence([1318.51, 1046.5], 0.9, 0.26, 0.24, [1, 0.5, 0.3, 0.18]); // E6 → C6
  }

  // `gap` is the time between note STARTS; it defaults to `durEach` so notes play
  // back-to-back, but can be shorter than the note length to let notes overlap and
  // ring (a chime), or longer to space them out. `harmonics` are the relative gains
  // of each overtone (index 0 = fundamental, 1 = 2×, 2 = 3×, …); the default is a
  // single pure sine.
  private playSequence(
    freqs: number[],
    durEach: number,
    peak: number,
    gap = durEach,
    harmonics: number[] = [1],
  ) {
    const ctx = this.getCtx();
    let t = ctx.currentTime + 0.005;
    for (const f of freqs) {
      this.playNote(ctx, f, t, durEach, peak, harmonics);
      t += gap;
    }
  }

  private playNote(
    ctx: AudioContext,
    freq: number,
    startAt: number,
    dur: number,
    peak: number,
    harmonics: number[] = [1],
  ) {
    // Sum the overtones through one gain envelope: each partial is a sine at an
    // integer multiple of the fundamental, scaled by its relative weight.
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, startAt);
    gain.gain.exponentialRampToValueAtTime(peak, startAt + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, startAt + dur);
    // High-cut: a 2nd-order low-pass (-12 dB/oct) at 5 kHz tames the harsh upper
    // overtones. Q 1/√2 = Butterworth (flat, no resonant bump).
    const lowpass = ctx.createBiquadFilter();
    lowpass.type = 'lowpass';
    lowpass.frequency.value = 5000;
    lowpass.Q.value = Math.SQRT1_2;
    gain.connect(lowpass).connect(this.bus ?? ctx.destination);
    const weightSum = harmonics.reduce((s, w) => s + w, 0) || 1;
    harmonics.forEach((weight, i) => {
      if (weight <= 0) return;
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = freq * (i + 1);
      const partial = ctx.createGain();
      partial.gain.value = weight / weightSum;
      osc.connect(partial).connect(gain);
      osc.start(startAt);
      osc.stop(startAt + dur + 0.02);
    });
  }
}
