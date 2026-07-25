// Minimal mouse-drag helper. Since the media windows became fixed auto-layout
// (issue #175), the only remaining caller is the RTC debug console, which stays
// draggable by its header. The element is positioned by updating its inline
// `left`/`top` (px); the caller sets an initial placement (CSS or inline).

export type MakeDraggableOptions = {
  // The element that receives the mousedown to begin dragging. Defaults to the
  // dragged element itself.
  handle?: HTMLElement;
};

// Clamps a candidate `left`/`top` so the element stays inside the viewport.
// If the element is larger than the viewport on an axis, it is pinned to 0 on
// that axis so at least the top-left (and the header) remain reachable.
function clampToViewport(
  left: number,
  top: number,
  width: number,
  height: number,
): { left: number; top: number } {
  const maxLeft = window.innerWidth - width;
  const maxTop = window.innerHeight - height;
  const clampedLeft = maxLeft < 0 ? 0 : Math.max(0, Math.min(left, maxLeft));
  const clampedTop = maxTop < 0 ? 0 : Math.max(0, Math.min(top, maxTop));
  return { left: clampedLeft, top: clampedTop };
}

// Makes `el` draggable by its handle. Returns a cleanup function that removes
// all listeners (call it when the element is destroyed).
export function makeDraggable(el: HTMLElement, options: MakeDraggableOptions = {}): () => void {
  const handle = options.handle ?? el;
  let dragging = false;
  let offsetX = 0;
  let offsetY = 0;
  let prevCursor = '';

  const onMouseDown = (e: MouseEvent) => {
    if (e.button !== 0) return;
    const rect = el.getBoundingClientRect();
    dragging = true;
    offsetX = e.clientX - rect.left;
    offsetY = e.clientY - rect.top;
    prevCursor = handle.style.cursor;
    handle.style.cursor = 'grabbing';
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
  };
}
