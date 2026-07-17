// Drives a per-frame callback that must keep running even while the tab is
// hidden. Browsers pause requestAnimationFrame in background tabs (and throttle
// setInterval to >=1s), which freezes any canvas.captureStream track built from
// the callback's output — the outgoing camera when a virtual background is on
// (media/vbg.ts) and the recording composite (media/compositor.ts). So: use rAF
// while visible for smooth, vsync-aligned frames, and fall back to a setInterval
// timer while hidden to keep the stream alive. Same problem core/background-ticker
// solves for the game loop; this is the media-pipeline equivalent.
//
// The callback always receives a performance.now()-based timestamp, so an
// existing FPS throttle inside it keeps working across the visible/hidden handover.
export class FrameDriver {
  private raf = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private onVisibility = () => this.resync();

  constructor(
    private tick: (nowMs: number) => void,
    // Timer cadence while hidden (ms). Matches a ~30fps capture.
    private intervalMs = 1000 / 30,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    document.addEventListener('visibilitychange', this.onVisibility);
    this.resync();
  }

  stop(): void {
    this.running = false;
    document.removeEventListener('visibilitychange', this.onVisibility);
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  // Select the driver that matches the current visibility, tearing down the other
  // so the two can never double-tick.
  private resync(): void {
    if (!this.running) return;
    if (document.hidden) {
      if (this.raf) {
        cancelAnimationFrame(this.raf);
        this.raf = 0;
      }
      if (this.timer === null) {
        this.timer = setInterval(() => this.tick(performance.now()), this.intervalMs);
      }
    } else {
      if (this.timer !== null) {
        clearInterval(this.timer);
        this.timer = null;
      }
      if (!this.raf) this.rafLoop();
    }
  }

  private rafLoop = (): void => {
    if (!this.running || document.hidden) return;
    this.tick(performance.now());
    this.raf = requestAnimationFrame(this.rafLoop);
  };
}
