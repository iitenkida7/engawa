// Modular LPC avatar (#141): reads the build-time manifest (zPos / paths /
// recolor material / palettes — generated from the upstream LPC repo's DATA,
// not its GPL code) and composites the chosen outfit into a per-outfit walk
// sheet the renderer blits, one frame per (direction row, column).
//
// Each part ships a single 64×64-framed walk.png (9 cols × 4 rows: up/left/
// down/right; col 0 = standing, cols 1–8 = the walk cycle). Color-free parts
// (body/head/face/hair/clothes) are recolored at runtime by mapping the sheet's
// source ramp (body=light, hair=orange, cloth=white) onto the chosen palette
// color — so adding colors costs no extra assets. Until a composite is ready
// the caller (canvas drawPlayer) falls back to the procedural colored circle.

import manifestJson from '@/assets/lpc/manifest.json';
import { t } from '@/core/i18n';
import {
  type Direction,
  defaultOutfit,
  type Outfit,
  type OutfitCategory,
  type OutfitCounts,
} from '@/world/outfit';

type LayerPaths = { male: string | null; female: string | null };
type Layer = { zPos: number; paths: LayerPaths };
type Part = { id: string; name: string; recolor: string | null; layers: Layer[] };
type Base = { zPos: number; recolor: string | null; paths: LayerPaths };
type HeadPart = { zPos: number; recolor: string | null; path: string | null };
type Manifest = {
  frame: number;
  cols: number;
  palettes: Record<string, Record<string, string[]>>;
  source: Record<string, string[]>;
  colors: { skin: string[]; hair: string[]; cloth: string[] };
  parts: {
    body: Base;
    head: { male: HeadPart; female: HeadPart };
    face: Base;
    hair: (Part | null)[];
    top: Part[];
    bottom: Part[];
    shoes: (Part | null)[];
    hat: (Part | null)[];
    glasses: (Part | null)[];
  };
};

const manifest = manifestJson as unknown as Manifest;
const P = manifest.parts;

const FRAME = manifest.frame; // 64
/** Frames per walk row (col 0 = standing; 1–8 = the walk cycle). */
export const COLS = manifest.cols; // 9
const SEX_NAMES = ['male', 'female'] as const;
const DIR_ROW: Record<Direction, number> = { up: 0, left: 1, down: 2, right: 3 };

// Vite resolves every bundled sheet to a URL at build time; match a manifest's
// relative path against the (longer, absolute) glob key by suffix. `import.meta.
// glob` is a Vite build-time macro (undefined under bun test), so resolve it
// lazily behind a guard — merely importing this module (e.g. via canvas.ts in a
// unit test) must not throw.
let sheetMap: Record<string, string> | null = null;
function sheets(): Record<string, string> {
  if (sheetMap) return sheetMap;
  try {
    sheetMap = import.meta.glob('@/assets/lpc/**/*.png', {
      eager: true,
      query: '?url',
      import: 'default',
    }) as Record<string, string>;
  } catch {
    sheetMap = {};
  }
  return sheetMap;
}
function sheetUrl(rel: string | null): string | null {
  if (!rel) return null;
  const map = sheets();
  for (const k in map) {
    if (k.endsWith(`/${rel}`)) return map[k];
  }
  return null;
}

// ---- public catalog data (editor + renderer) ------------------------------
export const OUTFIT_COUNTS: OutfitCounts = {
  sex: SEX_NAMES.length,
  skin: manifest.colors.skin.length,
  hair: P.hair.length,
  hairColor: manifest.colors.hair.length,
  top: P.top.length,
  topColor: manifest.colors.cloth.length,
  bottom: P.bottom.length,
  bottomColor: manifest.colors.cloth.length,
  shoes: P.shoes.length,
  hat: P.hat.length,
  glasses: P.glasses.length,
};

export const CATEGORY_LABELS: Record<OutfitCategory, string> = {
  sex: t('avatar.cat.sex'),
  skin: t('avatar.cat.skin'),
  hair: t('avatar.cat.hair'),
  hairColor: t('avatar.cat.hairColor'),
  top: t('avatar.cat.top'),
  topColor: t('avatar.cat.topColor'),
  bottom: t('avatar.cat.bottom'),
  bottomColor: t('avatar.cat.bottomColor'),
  shoes: t('avatar.cat.shoes'),
  hat: t('avatar.cat.hat'),
  glasses: t('avatar.cat.glasses'),
};

const SEX_LABELS = [t('avatar.sex.male'), t('avatar.sex.female')];

/** The display label for a given category option (for the editor's carousel). */
export function optionLabel(category: OutfitCategory, index: number): string {
  switch (category) {
    case 'sex':
      return SEX_LABELS[index] ?? '-';
    case 'skin':
      return manifest.colors.skin[index] ?? '-';
    case 'hairColor':
      return manifest.colors.hair[index] ?? '-';
    case 'topColor':
    case 'bottomColor':
      return manifest.colors.cloth[index] ?? '-';
    case 'hair':
      return P.hair[index]?.name ?? t('common.none');
    case 'top':
      return P.top[index]?.name ?? '-';
    case 'bottom':
      return P.bottom[index]?.name ?? '-';
    case 'shoes':
      return P.shoes[index]?.name ?? t('common.barefoot');
    case 'hat':
      return P.hat[index]?.name ?? t('common.none');
    case 'glasses':
      return P.glasses[index]?.name ?? t('common.none');
  }
}

/**
 * A representative hex swatch for a color-category option (mid ramp tone), or
 * null for non-color categories — the editor uses it to render a color chip.
 */
export function colorSwatch(category: OutfitCategory, index: number): string | null {
  const mid = (arr: string[] | undefined) =>
    arr ? (arr[Math.floor(arr.length / 2)] ?? null) : null;
  switch (category) {
    case 'skin':
      return mid(manifest.palettes.body[manifest.colors.skin[index]]);
    case 'hairColor':
      return mid(manifest.palettes.hair[manifest.colors.hair[index]]);
    case 'topColor':
    case 'bottomColor':
      return mid(manifest.palettes.cloth[manifest.colors.cloth[index]]);
    default:
      return null;
  }
}

// Where the in-app "クレジット" link points (the committed per-part credits).
export const LPC_CREDITS_URL =
  'https://github.com/iitenkida7/engawa/blob/main/engawa/client/src/assets/lpc/CREDITS.csv';

// ---- compositing ----------------------------------------------------------
function sig(o: Outfit): string {
  return [
    o.sex,
    o.skin,
    o.hair,
    o.hairColor,
    o.top,
    o.topColor,
    o.bottom,
    o.bottomColor,
    o.shoes,
    o.hat,
    o.glasses,
  ].join('|');
}

type RLayer = { zPos: number; url: string; material: string | null; color: string | null };

function pushPart(out: RLayer[], part: Part | null, sex: 'male' | 'female', color: string | null) {
  if (!part) return;
  for (const layer of part.layers) {
    const url = sheetUrl(layer.paths[sex]);
    if (url) out.push({ zPos: layer.zPos, url, material: part.recolor, color });
  }
}

function resolveLayers(o: Outfit): RLayer[] {
  const sex = SEX_NAMES[o.sex] ?? 'male';
  const skin = manifest.colors.skin[o.skin] ?? manifest.colors.skin[0];
  const hairColor = manifest.colors.hair[o.hairColor] ?? manifest.colors.hair[0];
  const topColor = manifest.colors.cloth[o.topColor] ?? manifest.colors.cloth[0];
  const bottomColor = manifest.colors.cloth[o.bottomColor] ?? manifest.colors.cloth[0];
  const out: RLayer[] = [];

  const bodyUrl = sheetUrl(manifest.parts.body.paths[sex]);
  if (bodyUrl) out.push({ zPos: P.body.zPos, url: bodyUrl, material: P.body.recolor, color: skin });
  const head = P.head[sex];
  const headUrl = sheetUrl(head.path);
  if (headUrl) out.push({ zPos: head.zPos, url: headUrl, material: head.recolor, color: skin });
  const faceUrl = sheetUrl(P.face.paths[sex]);
  if (faceUrl) out.push({ zPos: P.face.zPos, url: faceUrl, material: P.face.recolor, color: skin });

  pushPart(out, P.hair[o.hair], sex, hairColor);
  pushPart(out, P.top[o.top], sex, topColor);
  pushPart(out, P.bottom[o.bottom], sex, bottomColor);
  pushPart(out, P.shoes[o.shoes], sex, null);
  pushPart(out, P.hat[o.hat], sex, null);
  pushPart(out, P.glasses[o.glasses], sex, null);

  return out.sort((a, b) => a.zPos - b.zPos);
}

function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : [0, 0, 0];
}
function sameRamp(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v.toLowerCase() === b[i].toLowerCase());
}

export class CharacterSheet {
  private images = new Map<string, HTMLImageElement | null>();
  private loading = new Map<string, Promise<HTMLImageElement | null>>();
  private recolors = new Map<string, HTMLCanvasElement>();
  private composites = new Map<string, HTMLCanvasElement>();
  private building = new Set<string>();
  private onUpdate: (() => void) | null;

  /** onUpdate fires when a composite finishes (so a static preview can repaint). */
  constructor(onUpdate?: () => void) {
    this.onUpdate = onUpdate ?? null;
  }

  private loadImage(url: string): Promise<HTMLImageElement | null> {
    const cached = this.loading.get(url);
    if (cached) return cached;
    const p = new Promise<HTMLImageElement | null>((resolve) => {
      const img = new Image();
      img.onload = () => {
        this.images.set(url, img);
        resolve(img);
      };
      img.onerror = () => {
        this.images.set(url, null);
        resolve(null);
      };
      img.src = url;
    });
    this.loading.set(url, p);
    return p;
  }

  // Recolor one sheet (source ramp → target palette color), cached.
  private recolor(
    url: string,
    material: string,
    color: string,
    img: HTMLImageElement,
  ): HTMLCanvasElement | HTMLImageElement {
    const target = manifest.palettes[material]?.[color];
    const source = manifest.source[material];
    if (!target || !source || sameRamp(target, source)) return img; // identity
    const key = `${url}|${material}|${color}`;
    const hit = this.recolors.get(key);
    if (hit) return hit;
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    const cx = c.getContext('2d', { willReadFrequently: true });
    if (!cx) return img;
    cx.imageSmoothingEnabled = false;
    cx.drawImage(img, 0, 0);
    const data = cx.getImageData(0, 0, c.width, c.height);
    const px = data.data;
    const src = source.map(hexToRgb);
    const dst = target.map(hexToRgb);
    for (let i = 0; i < px.length; i += 4) {
      if (px[i + 3] === 0) continue;
      const r = px[i];
      const g = px[i + 1];
      const b = px[i + 2];
      for (let j = 0; j < src.length; j++) {
        if (
          Math.abs(r - src[j][0]) <= 1 &&
          Math.abs(g - src[j][1]) <= 1 &&
          Math.abs(b - src[j][2]) <= 1
        ) {
          px[i] = dst[j][0];
          px[i + 1] = dst[j][1];
          px[i + 2] = dst[j][2];
          break;
        }
      }
    }
    cx.putImageData(data, 0, 0);
    this.recolors.set(key, c);
    return c;
  }

  private async build(o: Outfit): Promise<void> {
    const key = sig(o);
    if (this.composites.has(key) || this.building.has(key)) return;
    this.building.add(key);
    const layers = resolveLayers(o);
    const imgs = await Promise.all(layers.map((l) => this.loadImage(l.url)));
    const c = document.createElement('canvas');
    c.width = FRAME * COLS;
    c.height = FRAME * 4;
    const cx = c.getContext('2d');
    if (cx) {
      cx.imageSmoothingEnabled = false;
      for (let i = 0; i < layers.length; i++) {
        const img = imgs[i];
        if (!img) continue;
        const l = layers[i];
        const drawable =
          l.material && l.color ? this.recolor(l.url, l.material, l.color, img) : img;
        cx.drawImage(drawable, 0, 0);
      }
    }
    this.composites.set(key, c);
    this.building.delete(key);
    this.onUpdate?.();
  }

  /** The composite sheet for an outfit, or null while it builds (kicks off build). */
  getComposite(o: Outfit): HTMLCanvasElement | null {
    const hit = this.composites.get(sig(o));
    if (hit) return hit;
    void this.build(o);
    return null;
  }

  /**
   * Draw the avatar's (dir,col) frame centered horizontally at `centerX`, feet
   * at `footY`, scaled by `scale`. Returns false (caller falls back to a circle)
   * until the composite is ready. `imageSmoothingEnabled` is forced off for
   * crisp pixel art and restored afterward.
   */
  draw(
    ctx: CanvasRenderingContext2D,
    outfit: Outfit,
    dir: Direction,
    col: number,
    centerX: number,
    footY: number,
    scale: number,
  ): boolean {
    const sheet = this.getComposite(outfit);
    if (!sheet) return false;
    const row = DIR_ROW[dir];
    const c = Math.max(0, Math.min(COLS - 1, Math.trunc(col)));
    const dw = FRAME * scale;
    const dh = FRAME * scale;
    const dx = centerX - dw / 2;
    const dy = footY - dh;
    const prev = ctx.imageSmoothingEnabled;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(sheet, c * FRAME, row * FRAME, FRAME, FRAME, dx, dy, dw, dh);
    ctx.imageSmoothingEnabled = prev;
    return true;
  }
}

export { defaultOutfit };
