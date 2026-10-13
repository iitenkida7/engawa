// Tiny WebAudio-synthesized chimes for proximity in/out. No assets.
//
// The AudioContext is created lazily on the first chime so that the user's
// initial gesture (clicking 入室) counts as activation — without that, browsers
// suspend the context and the first sound is silent.

export class SoundManager {
  private ctx: AudioContext | null = null;

  private getCtx(): AudioContext {
    if (!this.ctx) {
      const Ctor =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new Ctor();
    }
    // Some browsers leave the context suspended until a gesture; resume on each play.
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    return this.ctx;
  }

  // Rising 2-note chime when someone enters the call range.
  enter() {
    this.playSequence([523.25, 783.99], 0.08, 0.18); // C5 → G5
  }

  // Falling 2-note chime when someone leaves.
  leave() {
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
    gain.connect(ctx.destination);
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
