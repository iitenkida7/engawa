// Pure helpers behind the pointer / pen drawn over a screenshare (ui/annotate.ts).
//
// Marks travel as 0–1 fractions of the SHARED FRAME (not of the window), so a
// mark lands on the same spot of the slide for everyone whatever their window
// size or letterboxing.

export type Pt = { x: number; y: number };
export type Rect = { x: number; y: number; w: number; h: number };

// A stroke holds for this long after its last point, then fades out over the
// next FADE ms (laser-pen style: nothing to clean up, and nothing for a late
// joiner to be shown).
export const STROKE_HOLD_MS = 3000;
export const STROKE_FADE_MS = 1000;
// A pointer that has not moved for this long is dropped (its sender may have
// closed the window without ever sending "off").
export const POINTER_TTL_MS = 2500;

// How often we flush the points gathered so far / the pointer position, and the
// most points one message may carry (the server bounds it at the same number).
export const ANNOTATE_SEND_MS = 50;
export const ANNOTATE_MAX_POINTS = 60;

// The rectangle the video's picture actually occupies inside its box with
// `object-fit: contain` (letterboxed screenshare). With an unknown video size
// the whole box is used.
export function contentRect(boxW: number, boxH: number, videoW: number, videoH: number): Rect {
  if (boxW <= 0 || boxH <= 0) return { x: 0, y: 0, w: 0, h: 0 };
  if (videoW <= 0 || videoH <= 0) return { x: 0, y: 0, w: boxW, h: boxH };
  const scale = Math.min(boxW / videoW, boxH / videoH);
  const w = videoW * scale;
  const h = videoH * scale;
  return { x: (boxW - w) / 2, y: (boxH - h) / 2, w, h };
}

// A point inside the box → fraction of the frame. null when the point is in the
// letterbox bars (not on the shared picture), so nothing is drawn off the slide.
export function toFrac(px: number, py: number, rect: Rect): Pt | null {
  if (rect.w <= 0 || rect.h <= 0) return null;
  const x = (px - rect.x) / rect.w;
  const y = (py - rect.y) / rect.h;
  if (x < 0 || x > 1 || y < 0 || y > 1) return null;
  return { x, y };
}

export function fromFrac(p: Pt, rect: Rect): Pt {
  return { x: rect.x + p.x * rect.w, y: rect.y + p.y * rect.h };
}

// Opacity of a stroke whose newest point arrived at `lastAt`.
export function strokeAlpha(now: number, lastAt: number): number {
  const age = now - lastAt;
  if (age <= STROKE_HOLD_MS) return 1;
  return Math.max(0, 1 - (age - STROKE_HOLD_MS) / STROKE_FADE_MS);
}

// Flat [x0, y0, x1, y1, …] ⇄ points.
export function flatToPoints(flat: number[]): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i + 1 < flat.length; i += 2) out.push({ x: flat[i], y: flat[i + 1] });
  return out;
}
export function pointsToFlat(pts: Pt[]): number[] {
  const out: number[] = [];
  for (const p of pts) out.push(p.x, p.y);
  return out;
}

// Split a run of points into message-sized chunks. Chunk i+1 starts at the last
// point of chunk i, so the line stays joined across messages.
export function chunkPoints(pts: Pt[], max: number = ANNOTATE_MAX_POINTS): Pt[][] {
  if (pts.length <= max) return pts.length ? [pts] : [];
  const chunks: Pt[][] = [];
  let i = 0;
  while (i < pts.length) {
    const end = Math.min(pts.length, i + max);
    chunks.push(pts.slice(i, end));
    if (end >= pts.length) break;
    i = end - 1;
  }
  return chunks;
}
