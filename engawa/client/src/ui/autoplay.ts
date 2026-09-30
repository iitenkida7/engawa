// Recovery for remote media whose play() the browser refused (issue #201).
//
// Safari (iOS especially) and tabs that receive audio before any user gesture
// reject HTMLMediaElement.play() with NotAllowedError. Swallowing that left the
// peer's voice silent for good — nothing ever called play() again. The gate
// remembers every refused element and replays them all on the next user
// gesture (pointerdown / keydown), telling the owner when playback is blocked
// (to show an "enable audio" prompt) and when it recovers (to hide it).

// Whether a play() rejection is the autoplay policy (as opposed to e.g. an
// AbortError from a srcObject swap, which needs no recovery).
export function isAutoplayBlocked(err: unknown): boolean {
  return (err as { name?: unknown } | null)?.name === 'NotAllowedError';
}

type Playable = Pick<HTMLMediaElement, 'play' | 'srcObject'>;

export class AutoplayGate {
  private blocked = new Set<Playable>();
  private onBlocked: () => void;
  private onUnlocked: () => void;
  private target: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;
  private armed = false;

  constructor(opts: {
    // Fired when playback first becomes blocked (not again until it recovers).
    onBlocked: () => void;
    // Fired once every blocked element has been handed back to play().
    onUnlocked: () => void;
    // Where user gestures are listened for (the document; injectable for tests).
    target?: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;
  }) {
    this.onBlocked = opts.onBlocked;
    this.onUnlocked = opts.onUnlocked;
    this.target = opts.target ?? document;
  }

  get isBlocked(): boolean {
    return this.blocked.size > 0;
  }

  // play() the element, queueing it for the next gesture if autoplay refused it.
  play(el: Playable) {
    el.play().catch((err: unknown) => {
      if (!isAutoplayBlocked(err)) return;
      const wasBlocked = this.isBlocked;
      this.blocked.add(el);
      this.arm();
      if (!wasBlocked) this.onBlocked();
    });
  }

  // Replay every blocked element. Called from a user gesture, so play() is now
  // allowed; one still refused re-enters the queue (and re-prompts). Elements
  // whose stream was detached in the meantime are dropped.
  unlock = () => {
    if (!this.isBlocked) return;
    const pending = [...this.blocked];
    this.blocked.clear();
    this.disarm();
    this.onUnlocked();
    for (const el of pending) {
      if (el.srcObject) this.play(el);
    }
  };

  private arm() {
    if (this.armed) return;
    this.armed = true;
    // Capture phase so the gesture is seen even if a handler stops propagation.
    this.target.addEventListener('pointerdown', this.unlock, true);
    this.target.addEventListener('keydown', this.unlock, true);
  }

  private disarm() {
    if (!this.armed) return;
    this.armed = false;
    this.target.removeEventListener('pointerdown', this.unlock, true);
    this.target.removeEventListener('keydown', this.unlock, true);
  }
}
