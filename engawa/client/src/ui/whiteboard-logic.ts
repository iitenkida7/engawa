// Pure helpers behind the whiteboard (ui/whiteboard.ts), split out so they can
// be tested without a canvas.

export type WbTool = 'pen' | 'marker' | 'text';

// Logical drawing size. The canvas is captured as a video track, so this is the
// resolution the other participants receive (16:9).
export const WB_WIDTH = 1280;
export const WB_HEIGHT = 720;

// Ink, red, blue, green, orange.
export const WB_COLORS = ['#1f2937', '#e5484d', '#2f6fed', '#2e9e5b', '#f5a524'] as const;

export const WB_TEXT_SIZE = 28;

export type StrokeStyle = { width: number; alpha: number };

// The marker is a wide, translucent stroke so text underneath stays readable;
// the pen is a thin opaque one.
export function strokeStyleFor(tool: 'pen' | 'marker'): StrokeStyle {
  return tool === 'marker' ? { width: 22, alpha: 0.35 } : { width: 4, alpha: 1 };
}

// Map a pointer position to logical canvas coordinates. The canvas is scaled by
// CSS, so its on-screen rect differs from WB_WIDTH x WB_HEIGHT.
export function toCanvasPoint(
  clientX: number,
  clientY: number,
  rect: { left: number; top: number; width: number; height: number },
  width = WB_WIDTH,
  height = WB_HEIGHT,
): { x: number; y: number } {
  if (rect.width <= 0 || rect.height <= 0) return { x: 0, y: 0 };
  const x = ((clientX - rect.left) / rect.width) * width;
  const y = ((clientY - rect.top) / rect.height) * height;
  return {
    x: Math.min(width, Math.max(0, x)),
    y: Math.min(height, Math.max(0, y)),
  };
}

// engawa-whiteboard-YYYYMMDD-HHmmss.png in local time.
export function whiteboardFileName(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const date = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
  const time = `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `engawa-whiteboard-${date}-${time}.png`;
}
