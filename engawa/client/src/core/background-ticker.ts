// A Worker whose only job is to post a message on a fixed interval. Web Worker
// timers keep firing while the page is in a background/hidden tab, where the
// main thread's requestAnimationFrame is paused and setInterval is throttled to
// >=1s (or frozen). The main thread drives the game loop from these ticks while
// hidden so position sync, speaking detection and the send policy don't stall
// mid-call. See app.ts for the visible(rAF)/hidden(worker) handover.

// Minimal view of the worker global. We avoid a `webworker` lib reference (which
// would clash with the DOM lib this project compiles against) and just type the
// two members we use.
const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<{ intervalMs: number }>) => void) | null;
  postMessage: (message: unknown) => void;
};

let timer: ReturnType<typeof setInterval> | null = null;

ctx.onmessage = (e) => {
  if (timer !== null) clearInterval(timer);
  timer = setInterval(() => ctx.postMessage(0), e.data.intervalMs);
};
