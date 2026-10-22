// Profile picture handling: take a user-chosen image file, centre-crop it to a
// square and downscale to a small thumbnail, then encode a compact data URL we
// can relay to peers like the avatar outfit (ui/avatar-editor.ts drives this).
//
// The stored image is SQUARE; every display site (roster, map label, camera-off
// placeholder) clips it to a circle itself, so there is one source image and no
// baked-in alpha edge. Kept small so broadcasting it over the WebSocket stays
// cheap (the server caps the relayed length — logic.ts MAX_AVATAR_IMAGE_LEN).

const STORAGE_KEY = 'engawa-profile-image';

// Output thumbnail edge (px). Larger than any display site needs (the camera-off
// placeholder is the biggest at ~96px), so it stays crisp without being heavy.
export const PROFILE_IMAGE_SIZE = 128;

// Max accepted input file size (bytes) before we even decode it — a guard so a
// huge upload can't lock the tab while the browser decodes it. The output is
// re-encoded tiny regardless.
export const MAX_PROFILE_INPUT_BYTES = 8 * 1024 * 1024;

/**
 * The source-pixel square to draw from, for a centre crop: the largest centred
 * square that fits the image, so a wide or tall photo keeps its middle. Pure, so
 * the crop maths is unit-tested without a canvas.
 */
export function coverSquare(srcW: number, srcH: number): { sx: number; sy: number; size: number } {
  const size = Math.max(0, Math.min(srcW, srcH));
  return { sx: (srcW - size) / 2, sy: (srcH - size) / 2, size };
}

/** Read the persisted profile picture (data URL) or null if none set. */
export function loadProfileImage(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

/** Persist (or, with null, clear) the profile picture. */
export function saveProfileImage(dataUrl: string | null): void {
  try {
    if (dataUrl === null) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, dataUrl);
  } catch {
    /* ignore private-mode storage errors */
  }
}

/**
 * Decode an image file, centre-crop to a square, downscale to PROFILE_IMAGE_SIZE
 * and return a compact data URL (WebP where supported, else JPEG). Rejects on a
 * non-image / oversized / undecodable file. Does NOT persist — the caller does.
 */
export async function processProfileImageFile(file: File): Promise<string> {
  if (!file.type.startsWith('image/')) throw new Error('not an image');
  if (file.size > MAX_PROFILE_INPUT_BYTES) throw new Error('file too large');

  const bitmap = await loadBitmap(file);
  try {
    const { sx, sy, size } = coverSquare(bitmap.width, bitmap.height);
    if (size <= 0) throw new Error('empty image');
    const canvas = document.createElement('canvas');
    canvas.width = PROFILE_IMAGE_SIZE;
    canvas.height = PROFILE_IMAGE_SIZE;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no 2d context');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, sx, sy, size, size, 0, 0, PROFILE_IMAGE_SIZE, PROFILE_IMAGE_SIZE);
    // WebP is smaller; Safari < 14 falls back to JPEG (both widely supported).
    const webp = canvas.toDataURL('image/webp', 0.8);
    return webp.startsWith('data:image/webp') ? webp : canvas.toDataURL('image/jpeg', 0.85);
  } finally {
    bitmap.close?.();
  }
}

// Decode to an ImageBitmap (preferred) or fall back to an <img> on browsers
// without createImageBitmap. The returned object always has width/height and an
// optional close().
async function loadBitmap(
  file: File,
): Promise<{ width: number; height: number; close?: () => void } & CanvasImageSource> {
  if (typeof createImageBitmap === 'function') {
    return createImageBitmap(file);
  }
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('decode failed'));
      el.src = url;
    });
    return Object.assign(img, { close: () => {} });
  } finally {
    URL.revokeObjectURL(url);
  }
}
