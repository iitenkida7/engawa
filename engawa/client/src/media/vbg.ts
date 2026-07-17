// Virtual camera backgrounds: blur or replace everything except the person.
//
// The heavy lifting (person segmentation) runs entirely in the browser via
// MediaPipe Tasks Vision (ImageSegmenter / selfie segmenter); the WASM runtime
// and model are lazy-loaded from a CDN the first time a background is enabled,
// matching engawa's existing reliance on external CDNs (Google STUN / Cloudflare)
// and keeping the npm/build footprint small. Media never touches our own server.
//
// The class wraps a raw camera MediaStream and exposes a processed stream from a
// canvas captureStream — so `media.ts` can swap it in for `camStream` and every
// downstream path (mesh/SFU send, self preview, recording) gets the effect for
// free. Pure helpers (settings parsing, downscale math, preset registry) are
// split out so they can be unit-tested without a canvas or WebGL, following the
// same pattern as proximity.ts / panels.ts.

import type { ImageSegmenter, ImageSegmenterResult } from '@mediapipe/tasks-vision';
import { fitRect } from '@/media/compositor';
import { FrameDriver } from '@/media/frame-driver';

// Whether the 2D context supports the `filter` property (checked on the prototype
// so a per-instance expando can't give a false positive). Safari < 18 and some
// WebViews lack it; there, assigning ctx.filter silently no-ops and the blur
// background would paint the RAW room — a privacy break. Detected once.
const CTX_FILTER_SUPPORTED =
  typeof CanvasRenderingContext2D !== 'undefined' && 'filter' in CanvasRenderingContext2D.prototype;

// Segmentation runs at most this often. The output captureStream is 30fps, so
// running the (GPU-heavy) segmenter on every 60/120Hz rAF tick was pure waste.
const SEG_INTERVAL_MS = 1000 / 30;

// A background choice is a single string: the reserved values 'off'/'blur', or a
// preset id (including 'custom' for a user-uploaded image). Stored as-is.
export const VBG_OFF = 'off';
export const VBG_BLUR = 'blur';
export const VBG_CUSTOM = 'custom';

export const VBG_STORAGE_KEY = 'engawa-vbg';
export const VBG_IMAGE_STORAGE_KEY = 'engawa-vbg-image';

// CDN-hosted WASM runtime (pinned to the installed package version) and model.
const MEDIAPIPE_VERSION = '0.10.35';
const WASM_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}/wasm`;
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite';

// A built-in background drawn programmatically (no binary assets to bundle).
export interface BgPreset {
  id: string;
  label: string;
  // Paint a full-bleed background of w×h. Pure: only touches the given context.
  paint: (ctx: CanvasRenderingContext2D, w: number, h: number) => void;
}

function linear(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  stops: [number, string][],
  vertical = true,
) {
  const g = ctx.createLinearGradient(0, 0, vertical ? 0 : w, vertical ? h : 0);
  for (const [at, color] of stops) g.addColorStop(at, color);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
}

// Built-in image presets. Gradients keep the feature asset-free while still
// reading as a clear background swap. 'custom' is handled separately (uploaded).
export const BG_PRESETS: BgPreset[] = [
  {
    id: 'office',
    label: '🏢 オフィス',
    paint: (ctx, w, h) =>
      linear(ctx, w, h, [
        [0, '#2b3242'],
        [1, '#1a1d24'],
      ]),
  },
  {
    id: 'sky',
    label: '🌤 青空',
    paint: (ctx, w, h) =>
      linear(ctx, w, h, [
        [0, '#7fc7ff'],
        [1, '#d8f0ff'],
      ]),
  },
  {
    id: 'sunset',
    label: '🌇 夕焼け',
    paint: (ctx, w, h) =>
      linear(ctx, w, h, [
        [0, '#3a2a55'],
        [0.5, '#c2557a'],
        [1, '#ffb36b'],
      ]),
  },
  {
    id: 'forest',
    label: '🌿 グリーン',
    paint: (ctx, w, h) =>
      linear(ctx, w, h, [
        [0, '#1e3d2f'],
        [1, '#3f7d5a'],
      ]),
  },
];

// All selectable choices in menu order (custom is appended by the UI only when
// an image is stored). Used to validate persisted values.
export function allChoices(): string[] {
  return [VBG_OFF, VBG_BLUR, ...BG_PRESETS.map((p) => p.id), VBG_CUSTOM];
}

// Parse a persisted choice string, falling back to 'off' for anything unknown.
// `hasCustom` lets the caller reject a stored 'custom' when no image is present.
export function parseVbgChoice(raw: string | null, hasCustom: boolean): string {
  if (!raw) return VBG_OFF;
  let value = raw;
  // Tolerate both a bare string and a JSON-wrapped { choice } object.
  if (raw.startsWith('{')) {
    try {
      const obj = JSON.parse(raw) as { choice?: unknown };
      value = typeof obj.choice === 'string' ? obj.choice : '';
    } catch {
      return VBG_OFF;
    }
  }
  if (value === VBG_CUSTOM) return hasCustom ? VBG_CUSTOM : VBG_OFF;
  return allChoices().includes(value) ? value : VBG_OFF;
}

export function serializeVbgChoice(choice: string): string {
  return JSON.stringify({ choice });
}

// Anything other than 'off' means we run the segmentation pipeline.
export function isProcessingChoice(choice: string): boolean {
  return choice !== VBG_OFF;
}

// Human label for the toolbar button, given the active choice.
export function choiceLabel(choice: string): string {
  if (choice === VBG_OFF) return '🪄 背景';
  if (choice === VBG_BLUR) return '🌫 ぼかし';
  if (choice === VBG_CUSTOM) return '🖼 画像';
  const preset = BG_PRESETS.find((p) => p.id === choice);
  return preset ? preset.label : '🪄 背景';
}

// Compute the downscaled dimensions for an uploaded image so the stored dataURL
// stays small (localStorage budget) while keeping the aspect ratio. Pure.
export function downscaleSize(srcW: number, srcH: number, max: number): { w: number; h: number } {
  if (srcW <= 0 || srcH <= 0) return { w: 0, h: 0 };
  const scale = Math.min(1, max / Math.max(srcW, srcH));
  return { w: Math.max(1, Math.round(srcW * scale)), h: Math.max(1, Math.round(srcH * scale)) };
}

// The drawing instruction for the background layer behind the person.
export type BgSpec = { kind: 'blur' } | { kind: 'image'; paint: BgPreset['paint'] };

// Read an image File, downscale it, and return a JPEG dataURL suitable for
// localStorage. Impure (uses DOM/canvas) so it lives next to the class.
export async function fileToDownscaledDataUrl(file: File, max = 1280): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    const { w, h } = downscaleSize(img.naturalWidth, img.naturalHeight, max);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2d context not available');
    ctx.drawImage(img, 0, 0, w, h);
    return canvas.toDataURL('image/jpeg', 0.82);
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('image load failed'));
    img.src = src;
  });
}

// Lazily import MediaPipe and build a VIDEO-mode segmenter. Kept out of the
// static import graph so the WASM only downloads when a background is first
// turned on.
async function createSegmenter(): Promise<ImageSegmenter> {
  const vision = await import('@mediapipe/tasks-vision');
  const fileset = await vision.FilesetResolver.forVisionTasks(WASM_BASE);
  return vision.ImageSegmenter.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: MODEL_URL, delegate: 'GPU' },
    runningMode: 'VIDEO',
    outputConfidenceMasks: true,
    outputCategoryMask: false,
  });
}

// Wraps a raw camera stream and produces a processed one. Lifecycle: construct →
// start() (async; may throw if the model/WASM can't load) → setSpec() to change
// the background live (no track swap) → stop().
export class VirtualBackground {
  private srcVideo = document.createElement('video');
  private out = document.createElement('canvas');
  private octx: CanvasRenderingContext2D;
  // Person layer at output resolution, and the segmentation mask as alpha.
  private person = document.createElement('canvas');
  private pctx: CanvasRenderingContext2D;
  private maskCanvas = document.createElement('canvas');
  private mctx: CanvasRenderingContext2D;
  private segmenter: ImageSegmenter | null = null;
  private outStream: MediaStream | null = null;
  private running = false;
  // rAF while visible, timer while hidden, so the outgoing camera doesn't freeze
  // on the last frame when the user switches tabs during a call (C7).
  private driver = new FrameDriver(() => this.tick(), SEG_INTERVAL_MS);
  private lastSegMs = 0;
  // Reused per-frame mask ImageData (re-allocated only when the mask size
  // changes), so we don't churn ~0.5MB/frame of garbage.
  private maskData: ImageData | null = null;
  private w = 320;
  private h = 240;

  constructor(
    private srcStream: MediaStream,
    private spec: BgSpec,
  ) {
    this.octx = ctx2d(this.out);
    this.pctx = ctx2d(this.person);
    this.mctx = ctx2d(this.maskCanvas);
  }

  // Swap the background drawing without touching the output track, so toggling
  // blur↔image↔preset never triggers an RTC renegotiation.
  setSpec(spec: BgSpec) {
    this.spec = spec;
  }

  async start(): Promise<MediaStream> {
    this.srcVideo.srcObject = this.srcStream;
    this.srcVideo.muted = true;
    this.srcVideo.playsInline = true;
    await this.srcVideo.play();

    const settings = this.srcStream.getVideoTracks()[0]?.getSettings() ?? {};
    this.w = settings.width || this.srcVideo.videoWidth || 320;
    this.h = settings.height || this.srcVideo.videoHeight || 240;
    this.out.width = this.w;
    this.out.height = this.h;
    this.person.width = this.w;
    this.person.height = this.h;

    // May throw (offline / CDN blocked / no WebGL) — the caller falls back to
    // the raw stream so the camera still works.
    this.segmenter = await createSegmenter();

    this.outStream = this.out.captureStream(30);
    for (const t of this.outStream.getVideoTracks()) t.contentHint = 'motion';
    this.running = true;
    this.driver.start();
    return this.outStream;
  }

  stop() {
    this.running = false;
    this.driver.stop();
    if (this.outStream) {
      for (const t of this.outStream.getTracks()) t.stop();
      this.outStream = null;
    }
    try {
      this.segmenter?.close();
    } catch {
      /* already closed */
    }
    this.segmenter = null;
    this.srcVideo.srcObject = null;
  }

  private tick = () => {
    if (!this.running) return;
    const now = performance.now();
    // Throttle to the output frame rate: the driver may fire faster (rAF on a
    // 120Hz display), but there's no point segmenting more often than we capture.
    if (now - this.lastSegMs < SEG_INTERVAL_MS) return;
    this.lastSegMs = now;
    const v = this.srcVideo;
    if (!this.segmenter || v.readyState < 2 || v.videoWidth === 0) return;
    try {
      this.segmenter.segmentForVideo(v, now, (res) => this.onResult(res));
    } catch {
      // A dropped/late frame is harmless; the next tick retries.
    }
  };

  private onResult(res: ImageSegmenterResult) {
    const mask = res.confidenceMasks?.[0];
    if (!mask) {
      // No mask this frame: show the plain camera so we never freeze.
      this.octx.drawImage(this.srcVideo, 0, 0, this.w, this.h);
      res.close();
      return;
    }
    const mw = mask.width;
    const mh = mask.height;
    const conf = mask.getAsFloat32Array(); // person confidence in [0,1] per pixel

    if (this.maskCanvas.width !== mw || this.maskCanvas.height !== mh) {
      this.maskCanvas.width = mw;
      this.maskCanvas.height = mh;
      this.maskData = null; // size changed → the cached buffer no longer fits
    }
    // Reuse one ImageData across frames (only its alpha channel changes), instead
    // of allocating a fresh mw×mh buffer every frame.
    const id = this.maskData ?? this.mctx.createImageData(mw, mh);
    this.maskData = id;
    for (let i = 0; i < conf.length; i++) {
      id.data[i * 4 + 3] = Math.round(conf[i] * 255); // encode mask into alpha
    }
    this.mctx.putImageData(id, 0, 0);

    const { w, h } = this;
    // Person layer: the live frame, keyed to the (upscaled, smoothed) mask alpha.
    this.pctx.clearRect(0, 0, w, h);
    this.pctx.drawImage(this.srcVideo, 0, 0, w, h);
    this.pctx.save();
    this.pctx.globalCompositeOperation = 'destination-in';
    this.pctx.imageSmoothingEnabled = true;
    this.pctx.drawImage(this.maskCanvas, 0, 0, w, h);
    this.pctx.restore();

    // Output = background, then the masked person on top.
    this.octx.clearRect(0, 0, w, h);
    this.paintBackground(w, h);
    this.octx.drawImage(this.person, 0, 0);

    mask.close();
    res.close();
  }

  private paintBackground(w: number, h: number) {
    const ctx = this.octx;
    if (this.spec.kind === 'blur') {
      if (CTX_FILTER_SUPPORTED) {
        ctx.save();
        ctx.filter = 'blur(8px)';
        // Overscan so the blur doesn't reveal transparent canvas at the edges.
        ctx.drawImage(this.srcVideo, -12, -12, w + 24, h + 24);
        ctx.restore();
      } else {
        // No 2D-context filter support (older Safari/WebViews): a raw drawImage
        // here would expose the un-blurred room the user asked to hide. Fall back
        // to an opaque fill so privacy is never silently broken.
        ctx.fillStyle = '#1a1d24';
        ctx.fillRect(0, 0, w, h);
      }
    } else {
      this.spec.paint(ctx, w, h);
    }
  }
}

// Build a cover-fit image painter for a decoded image (e.g. the custom upload),
// reusing the compositor's object-fit math.
export function imagePainter(img: HTMLImageElement): BgPreset['paint'] {
  return (ctx, w, h) => {
    const r = fitRect(img.naturalWidth, img.naturalHeight, 0, 0, w, h, 'cover');
    ctx.drawImage(img, r.x, r.y, r.w, r.h);
  };
}

function ctx2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2d context not available');
  return ctx;
}
