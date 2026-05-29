// Generic mouse-drag helper shared by the screenshare panel and the camera
// tiles. The element is positioned by updating its inline `left`/`top` (px).
// Position is never persisted — callers are expected to set an initial
// placement before/after applying this.

// Size (px) of the bottom-right corner reserved for the browser's native
// `resize: both` handle. mousedown inside this zone is ignored so the browser
// can drive the resize instead of starting a drag.
const RESIZE_HANDLE_PX = 16;

// Minimum number of px of the element (and thus its header) that must remain
// inside the viewport when clamping. Currently the element is kept fully
// inside, but elements larger than the viewport are pinned to the top-left so
// their header stays reachable.
const MIN_VISIBLE_PX = 0;

export type MakeDraggableOptions = {
  // The element that receives the mousedown to begin dragging. Defaults to the
  // dragged element itself.
  handle?: HTMLElement;
  // Called once when a drag starts (e.g. to bring the element to front).
  onStart?: () => void;
  // Optional guard: return false from mousedown to skip starting a drag (used
  // by the screenshare panel to only allow dragging in PiP mode).
  canDrag?: () => boolean;
};

// Every currently-draggable element, mapped to its options. Used by the shared
// `resize` handler to re-clamp all of them when the viewport shrinks. The
// options' `canDrag` guard also gates re-clamping so non-draggable layouts
// (e.g. the screenshare side/full modes anchored via inset) are left alone.
const registry = new Map<HTMLElement, MakeDraggableOptions>();
let resizeListenerAttached = false;

// Normalizes an element positioned with `right`/`bottom` into explicit
// `left`/`top` (px) so clamping has concrete coordinates to work with. Safe to
// call repeatedly: once `left`/`top` are set it is a no-op for that axis.
function normalizeToLeftTop(el: HTMLElement): void {
  const rect = el.getBoundingClientRect();
  const style = el.style;
  if (style.left === '' || style.left === 'auto' || style.right !== '') {
    style.left = `${rect.left}px`;
    style.right = 'auto';
  }
  if (style.top === '' || style.top === 'auto' || style.bottom !== '') {
    style.top = `${rect.top}px`;
    style.bottom = 'auto';
  }
}

// Clamps a candidate `left`/`top` so the element stays inside the viewport.
// If the element is larger than the viewport on an axis, it is pinned to 0 on
// that axis so at least the top-left (and the header) remain visible.
export function clampToViewport(
  left: number,
  top: number,
  width: number,
  height: number,
): { left: number; top: number } {
  const maxLeft = window.innerWidth - width - MIN_VISIBLE_PX;
  const maxTop = window.innerHeight - height - MIN_VISIBLE_PX;
  const clampedLeft = maxLeft < 0 ? 0 : Math.max(0, Math.min(left, maxLeft));
  const clampedTop = maxTop < 0 ? 0 : Math.max(0, Math.min(top, maxTop));
  return { left: clampedLeft, top: clampedTop };
}

// Re-clamps a single element to the current viewport, normalizing its
// positioning to left/top first.
export function clampElement(el: HTMLElement): void {
  // Hidden elements have no useful geometry; skip until they become visible.
  if (el.offsetParent === null && el.style.position !== 'fixed') return;
  normalizeToLeftTop(el);
  const rect = el.getBoundingClientRect();
  const { left, top } = clampToViewport(rect.left, rect.top, rect.width, rect.height);
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
}

function onWindowResize(): void {
  registry.forEach((options, el) => {
    // Skip elements that are currently not draggable: their position is owned
    // by CSS (e.g. screenshare side/full modes anchored via inset).
    if (options.canDrag && !options.canDrag()) return;
    clampElement(el);
  });
}

function ensureResizeListener(): void {
  if (resizeListenerAttached) return;
  window.addEventListener('resize', onWindowResize);
  resizeListenerAttached = true;
}

// Makes `el` draggable by its handle. Returns a cleanup function that removes
// all listeners (call it when the element is destroyed).
export function makeDraggable(el: HTMLElement, options: MakeDraggableOptions = {}): () => void {
  const handle = options.handle ?? el;
  let dragging = false;
  let offsetX = 0;
  let offsetY = 0;
  let prevCursor = '';

  registry.set(el, options);
  ensureResizeListener();

  const onMouseDown = (e: MouseEvent) => {
    if (e.button !== 0) return;
    if (options.canDrag && !options.canDrag()) return;
    // Defer to the browser's native resize handle in the bottom-right corner.
    const rect = el.getBoundingClientRect();
    const inResizeZone =
      e.clientX >= rect.right - RESIZE_HANDLE_PX && e.clientY >= rect.bottom - RESIZE_HANDLE_PX;
    if (inResizeZone) return;

    dragging = true;
    offsetX = e.clientX - rect.left;
    offsetY = e.clientY - rect.top;
    prevCursor = handle.style.cursor;
    handle.style.cursor = 'grabbing';
    options.onStart?.();
    // Suppress text selection while dragging.
    e.preventDefault();
  };

  const onMouseMove = (e: MouseEvent) => {
    if (!dragging) return;
    const rect = el.getBoundingClientRect();
    const { left, top } = clampToViewport(
      e.clientX - offsetX,
      e.clientY - offsetY,
      rect.width,
      rect.height,
    );
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
    // Clear any edge anchoring so left/top take effect.
    el.style.right = 'auto';
    el.style.bottom = 'auto';
  };

  const onMouseUp = () => {
    if (!dragging) return;
    dragging = false;
    handle.style.cursor = prevCursor;
  };

  handle.addEventListener('mousedown', onMouseDown);
  window.addEventListener('mousemove', onMouseMove);
  window.addEventListener('mouseup', onMouseUp);

  return () => {
    handle.removeEventListener('mousedown', onMouseDown);
    window.removeEventListener('mousemove', onMouseMove);
    window.removeEventListener('mouseup', onMouseUp);
    registry.delete(el);
    // Drop the shared resize listener once nothing is registered.
    if (registry.size === 0 && resizeListenerAttached) {
      window.removeEventListener('resize', onWindowResize);
      resizeListenerAttached = false;
    }
  };
}

// Shared z-index counter so the most-recently-grabbed tile/panel comes to the
// front. Starts above the static UI layers (screenshare-stage uses z6).
let topZ = 10;
export function bringToFront(el: HTMLElement): void {
  topZ += 1;
  el.style.zIndex = String(topZ);
}
