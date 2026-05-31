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

  private playSequence(freqs: number[], durEach: number, peak: number) {
    const ctx = this.getCtx();
    let t = ctx.currentTime + 0.005;
    for (const f of freqs) {
      this.playNote(ctx, f, t, durEach, peak);
      t += durEach;
    }
  }

  private playNote(ctx: AudioContext, freq: number, startAt: number, dur: number, peak: number) {
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = freq;
    const gain = ctx.createGain();
    // Quick attack + exponential decay for a clean "pin" / "pon" feel.
    gain.gain.setValueAtTime(0.0001, startAt);
    gain.gain.exponentialRampToValueAtTime(peak, startAt + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, startAt + dur);
    osc.connect(gain).connect(ctx.destination);
    osc.start(startAt);
    osc.stop(startAt + dur + 0.02);
  }
}
