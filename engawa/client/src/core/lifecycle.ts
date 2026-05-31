// Page-lifecycle helpers shared by the game loop (app.ts) and the background
// Worker ticker (background-ticker.ts). Kept as a small module with pure
// functions so the timing/guard logic is unit-testable, matching the
// "extract pure logic into a module" pattern used across the codebase.

// Background ticker cadence. While the tab is hidden the browser pauses
// requestAnimationFrame, so a Worker timer drives update() at this interval
// instead. 200ms (~5Hz) is plenty for a stationary background user: it keeps
// position sync, speaking detection and the send policy alive without burning
// cycles on a tab nobody is looking at.
export const BACKGROUND_TICK_INTERVAL_MS = 200;

// Frame delta clamp. A long gap (tab was hidden, debugger paused, GC stall)
// must never produce a giant physics step on the next tick, so the delta is
// capped. The first frame has no previous timestamp, so it uses a nominal 60fps
// step.
export const MAX_FRAME_DT = 0.1;
export const DEFAULT_FRAME_DT = 1 / 60;

// Seconds elapsed since the previous frame, clamped. `lastFrameMs === 0` means
// "no previous frame yet" (the loop has not run), so we return the nominal step.
export function computeFrameDt(lastFrameMs: number, nowMs: number): number {
  if (!lastFrameMs) return DEFAULT_FRAME_DT;
  return Math.min(MAX_FRAME_DT, (nowMs - lastFrameMs) / 1000);
}

// Whether closing the tab/window should be confirmed. We only want the browser's
// native "leave site?" prompt once the user has actually entered a workspace
// (joined), so an accidental close mid-call doesn't silently drop the session.
export function shouldConfirmUnload(joined: boolean): boolean {
  return joined;
}
