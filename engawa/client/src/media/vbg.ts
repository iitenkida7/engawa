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

import type { DrawingUtils, ImageSegmenter, ImageSegmenterResult } from '@mediapipe/tasks-vision';
import { t } from '@/core/i18n';
import { fitRect } from '@/media/compositor';
import { FrameDriver } from '@/media/frame-driver';
import { CAM_FPS } from '@/rtc/cam-bitrate';

// Whether the 2D context supports the `filter` property (checked on the prototype
// so a per-instance expando can't give a false positive). Safari < 18 and some
// WebViews lack it; there, assigning ctx.filter silently no-ops and the blur
// background would paint the RAW room — a privacy break. Detected once.
const CTX_FILTER_SUPPORTED =
  typeof CanvasRenderingContext2D !== 'undefined' && 'filter' in CanvasRenderingContext2D.prototype;

// Segmentation runs at most this often: the camera rate (CAM_FPS), which is
// also what the output captureStream and the encoder run at. Segmenting more
// often would only re-process the same camera frame.
const SEG_INTERVAL_MS = 1000 / CAM_FPS;

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
    label: t('vbg.office'),
    paint: (ctx, w, h) =>
      linear(ctx, w, h, [
        [0, '#2b3242'],
        [1, '#1a1d24'],
      ]),
  },
  {
    id: 'sky',
    label: t('vbg.sky'),
    paint: (ctx, w, h) =>
      linear(ctx, w, h, [
        [0, '#7fc7ff'],
        [1, '#d8f0ff'],
      ]),
  },
  {
    id: 'sunset',
    label: t('vbg.sunset'),
    paint: (ctx, w, h) =>
      linear(ctx, w, h, [
        [0, '#3a2a55'],
        [0.5, '#c2557a'],
        [1, '#ffb36b'],
      ]),
  },
  {
    id: 'forest',
    label: t('vbg.green'),
    paint: (ctx, w, h) =>
      linear(ctx, w, h, [
        [0, '#1e3d2f'],
        [1, '#3f7d5a'],
      ]),
  },
];

// Bundled image backgrounds (#233): drop CC0 JPG/PNG/WebP files into
// client/src/assets/backgrounds/ and they appear as presets automatically — no
// code change needed. The filename (sans extension) becomes the id/label.
export interface BgImagePreset {
  id: string;
  label: string;
  url: string;
}

// `import.meta.glob` is a Vite build-time macro (undefined under bun test), so
// resolve it lazily behind a guard — importing this module in a unit test must
// not throw (mirrors world/character.ts). Vite rewrites each match to a URL.
let imagePresetCache: BgImagePreset[] | null = null;
export function imagePresets(): BgImagePreset[] {
  if (imagePresetCache) return imagePresetCache;
  let map: Record<string, string> = {};
  try {
    map = import.meta.glob('@/assets/backgrounds/*.{jpg,jpeg,png,webp}', {
      eager: true,
      query: '?url',
      import: 'default',
    }) as Record<string, string>;
  } catch {
    map = {};
  }
  imagePresetCache = Object.entries(map)
    .map(([path, url]) => {
      const base = (path.split('/').pop() ?? path).replace(/\.[^.]+$/, '');
      const label = base.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
      return { id: `${VBG_IMAGE_PREFIX}${base}`, label, url };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
  return imagePresetCache;
}

// Bundled image preset ids are namespaced so they never collide with the
// gradient preset ids or the reserved off/blur/custom values.
export const VBG_IMAGE_PREFIX = 'bg:';
export function isImagePresetChoice(choice: string): boolean {
  return choice.startsWith(VBG_IMAGE_PREFIX);
}

// All selectable choices in menu order (custom is appended by the UI only when
// an image is stored). Used to validate persisted values.
export function allChoices(): string[] {
  return [
    VBG_OFF,
    VBG_BLUR,
    ...BG_PRESETS.map((p) => p.id),
    ...imagePresets().map((p) => p.id),
    VBG_CUSTOM,
  ];
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
  if (choice === VBG_OFF) return t('vbg.btnBg');
  if (choice === VBG_BLUR) return t('vbg.btnBlur');
  if (choice === VBG_CUSTOM) return t('vbg.btnImage');
  if (isImagePresetChoice(choice)) {
    return imagePresets().find((p) => p.id === choice)?.label ?? t('vbg.btnImage');
  }
  const preset = BG_PRESETS.find((p) => p.id === choice);
  return preset ? preset.label : t('vbg.btnBg');
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

// Background blur is drawn at 1/BLUR_DOWNSCALE of the output and stretched back
// up by the GPU, so the 2D blur filter only ever touches a small canvas; the
// upscale itself adds softness. BLUR_PX is the blur at full output scale.
const BLUR_DOWNSCALE = 4;
const BLUR_PX = 8;

type Pipeline = {
  segmenter: ImageSegmenter;
  drawer: DrawingUtils;
};

// Lazily import MediaPipe and build a VIDEO-mode segmenter bound to `canvas`, plus
// a DrawingUtils on the same WebGL2 context. Sharing the context keeps the mask a
// GPU texture that drawConfidenceMask blends with directly — no GPU→CPU readback
// per frame. Kept out of the static import graph so the WASM only downloads when
// a background is first turned on.
async function createPipeline(
  canvas: HTMLCanvasElement,
  gl: WebGL2RenderingContext,
): Promise<Pipeline> {
  const vision = await import('@mediapipe/tasks-vision');
  const fileset = await vision.FilesetResolver.forVisionTasks(WASM_BASE);
  const segmenter = await vision.ImageSegmenter.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: MODEL_URL, delegate: 'GPU' },
    canvas,
    runningMode: 'VIDEO',
    outputConfidenceMasks: true,
    outputCategoryMask: false,
  });
  return { segmenter, drawer: new vision.DrawingUtils(gl) };
}

// Wraps a raw camera stream and produces a processed one. Lifecycle: construct →
// start() (async; may throw if the model/WASM/WebGL2 can't load) → setSpec() to
// change the background live (no track swap) → stop().
//
// Per frame: the segmenter writes the person mask as a texture on the output
// canvas's WebGL2 context, and drawConfidenceMask blends background → camera by
// it in one GPU pass straight onto that canvas, which is the captured stream.
export class VirtualBackground {
  private srcVideo = document.createElement('video');
  // WebGL2 output canvas: shared with the segmenter and captured as the stream.
  private out = document.createElement('canvas');
  // 2D canvas holding the background layer handed to the GPU blend: the
  // downscaled blurred camera, or the painted image/gradient.
  private bg = document.createElement('canvas');
  private bctx: CanvasRenderingContext2D;
  // An image/gradient background only needs painting once per setSpec.
  private bgPainted = false;
  private pipeline: Pipeline | null = null;
  private outStream: MediaStream | null = null;
  private running = false;
  // rAF while visible, timer while hidden, so the outgoing camera doesn't freeze
  // on the last frame when the user switches tabs during a call (C7).
  private driver = new FrameDriver(() => this.tick(), SEG_INTERVAL_MS);
  private lastSegMs = 0;
  private w = 320;
  private h = 240;

  constructor(
    private srcStream: MediaStream,
    private spec: BgSpec,
  ) {
    this.bctx = ctx2d(this.bg);
  }

  // Swap the background drawing without touching the output track, so toggling
  // blur↔image↔preset never triggers an RTC renegotiation.
  setSpec(spec: BgSpec) {
    this.spec = spec;
    this.bgPainted = false;
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

    // Create the context ourselves, before MediaPipe asks for one on the same
    // canvas, so the attributes are ours: opaque output, and a drawing buffer
    // that survives until captured (the hidden-tab timer draws outside rAF).
    const gl = this.out.getContext('webgl2', {
      alpha: false,
      antialias: false,
      preserveDrawingBuffer: true,
    });
    // May throw (offline / CDN blocked / no WebGL2) — the caller falls back to
    // the raw stream so the camera still works.
    if (!gl) throw new Error('WebGL2 not available');
    this.pipeline = await createPipeline(this.out, gl);

    this.outStream = this.out.captureStream(CAM_FPS);
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
      this.pipeline?.drawer.close();
      this.pipeline?.segmenter.close();
    } catch {
      /* already closed */
    }
    this.pipeline = null;
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
    if (!this.pipeline || v.readyState < 2 || v.videoWidth === 0) return;
    try {
      this.pipeline.segmenter.segmentForVideo(v, now, (res) => this.onResult(res));
    } catch {
      // A dropped/late frame is harmless; the next tick retries.
    }
  };

  // The mask is only valid inside the segmenter callback, so blend right here.
  // No mask this frame: keep the previous composite on the canvas rather than
  // showing the raw camera, which would expose the room the user chose to hide.
  private onResult(res: ImageSegmenterResult) {
    const mask = res.confidenceMasks?.[0];
    if (mask && this.pipeline) {
      this.paintBackground();
      // Low confidence → background, high → the camera (the person).
      this.pipeline.drawer.drawConfidenceMask(mask, this.bg, this.srcVideo);
    }
    res.close();
  }

  private paintBackground() {
    const ctx = this.bctx;
    if (this.spec.kind === 'blur') {
      const bw = Math.max(1, Math.round(this.w / BLUR_DOWNSCALE));
      const bh = Math.max(1, Math.round(this.h / BLUR_DOWNSCALE));
      if (this.bg.width !== bw || this.bg.height !== bh) {
        this.bg.width = bw;
        this.bg.height = bh;
      }
      if (CTX_FILTER_SUPPORTED) {
        const px = BLUR_PX / BLUR_DOWNSCALE;
        // Overscan so the blur doesn't pull transparent canvas in at the edges.
        const o = px * 1.5;
        ctx.save();
        ctx.filter = `blur(${px}px)`;
        ctx.drawImage(this.srcVideo, -o, -o, bw + 2 * o, bh + 2 * o);
        ctx.restore();
      } else {
        // No 2D-context filter support (older Safari/WebViews): a raw drawImage
        // here would expose the un-blurred room the user asked to hide. Fall back
        // to an opaque fill so privacy is never silently broken.
        ctx.fillStyle = '#1a1d24';
        ctx.fillRect(0, 0, bw, bh);
      }
      return;
    }
    if (this.bgPainted) return;
    const { w, h } = this;
    if (this.bg.width !== w || this.bg.height !== h) {
      this.bg.width = w;
      this.bg.height = h;
    }
    ctx.clearRect(0, 0, w, h);
    this.spec.paint(ctx, w, h);
    this.bgPainted = true;
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
