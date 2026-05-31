// Modular LPC avatar: loads the layered part sprites and composites them into a
// per-outfit sheet the renderer blits (#141). Mirrors world/sprites.ts' load /
// whenReady / fallback discipline: until every layer is loaded `ready` is false
// and the caller (canvas drawPlayer) falls back to the procedural colored circle.
//
// Source art is LPC (Universal-LPC-Spritesheet-Character-Generator), bundled
// under assets/lpc/ with per-part credits in CREDITS.csv. The body sheet ships
// in a single skin tone, so skin variants are produced at runtime as a multiply
// tint (offscreen) — keeping the committed asset set tiny.

import accNerd from '@/assets/lpc/acc-glasses-nerd.png?url';
import accRound from '@/assets/lpc/acc-glasses-round.png?url';
import bodyUrl from '@/assets/lpc/body.png?url';
import bottomPants from '@/assets/lpc/bottom-pants.png?url';
import bottomShorts from '@/assets/lpc/bottom-shorts.png?url';
import bottomSkirt from '@/assets/lpc/bottom-skirt.png?url';
import hairAfro from '@/assets/lpc/hair-afro.png?url';
import hairBob from '@/assets/lpc/hair-bob.png?url';
import hairLong from '@/assets/lpc/hair-long.png?url';
import hairMessy from '@/assets/lpc/hair-messy.png?url';
import hairPage from '@/assets/lpc/hair-page.png?url';
import hairPlain from '@/assets/lpc/hair-plain.png?url';
import topFormal from '@/assets/lpc/top-formal.png?url';
import topLongsleeve from '@/assets/lpc/top-longsleeve.png?url';
import topPolo from '@/assets/lpc/top-polo.png?url';
import topShortsleeve from '@/assets/lpc/top-shortsleeve.png?url';
import topSleeveless from '@/assets/lpc/top-sleeveless.png?url';
import {
  type Direction,
  defaultOutfit,
  type Outfit,
  type OutfitCategory,
  type OutfitCounts,
} from '@/world/outfit';

// One 64×64 frame; the bundled part PNGs stack the 4 facing-direction standing
// frames vertically (up, left, down, right) into a 64×256 sheet.
const FRAME = 64;

const DIR_ROW: Record<Direction, number> = { up: 0, left: 1, down: 2, right: 3 };

// Skin tones, applied as a multiply tint over the single base body sheet. null =
// the base tone (untinted). Index order is the editor's "肌の色" carousel order.
export const SKIN_TINTS: { label: string; tint: string | null }[] = [
  { label: 'ライト', tint: null },
  { label: 'ナチュラル', tint: '#e6b98f' },
  { label: 'タン', tint: '#c8895a' },
  { label: 'ブラウン', tint: '#9c6038' },
  { label: 'ダーク', tint: '#6e4329' },
];

type Part = { label: string; url: string };

export const HAIR: Part[] = [
  { label: 'プレーン', url: hairPlain },
  { label: 'ページ', url: hairPage },
  { label: 'ボブ', url: hairBob },
  { label: 'くせ毛', url: hairMessy },
  { label: 'ロング', url: hairLong },
  { label: 'アフロ', url: hairAfro },
];

export const TOP: Part[] = [
  { label: '長袖', url: topLongsleeve },
  { label: '半袖', url: topShortsleeve },
  { label: 'ノースリーブ', url: topSleeveless },
  { label: 'フォーマル', url: topFormal },
  { label: 'ポロ', url: topPolo },
];

export const BOTTOM: Part[] = [
  { label: 'パンツ', url: bottomPants },
  { label: 'ショートパンツ', url: bottomShorts },
  { label: 'スカート', url: bottomSkirt },
];

// Accessory index 0 is "none" (no overlay); the rest are face overlays.
export const ACC: { label: string; url: string | null }[] = [
  { label: 'なし', url: null },
  { label: '丸メガネ', url: accRound },
  { label: '黒ぶちメガネ', url: accNerd },
];

// Per-category option counts — the source of truth for outfit normalization.
export const OUTFIT_COUNTS: OutfitCounts = {
  skin: SKIN_TINTS.length,
  hair: HAIR.length,
  top: TOP.length,
  bottom: BOTTOM.length,
  acc: ACC.length,
};

// Human labels for the editor's category headers.
export const CATEGORY_LABELS: Record<OutfitCategory, string> = {
  skin: '肌の色',
  hair: '髪型',
  top: '上着',
  bottom: '下衣',
  acc: '小物',
};

/** The display label for a given category option (for the editor's carousel). */
export function optionLabel(category: OutfitCategory, index: number): string {
  switch (category) {
    case 'skin':
      return SKIN_TINTS[index]?.label ?? '-';
    case 'hair':
      return HAIR[index]?.label ?? '-';
    case 'top':
      return TOP[index]?.label ?? '-';
    case 'bottom':
      return BOTTOM[index]?.label ?? '-';
    case 'acc':
      return ACC[index]?.label ?? '-';
  }
}

// Where the in-app "クレジット" link points (the committed per-part credits).
export const LPC_CREDITS_URL =
  'https://github.com/iitenkida7/engawa/blob/main/engawa/client/src/assets/lpc/CREDITS.csv';

function outfitKey(o: Outfit): string {
  return `${o.skin}|${o.hair}|${o.top}|${o.bottom}|${o.acc}`;
}

export class CharacterSheet {
  ready = false;
  private images = new Map<string, HTMLImageElement>();
  private pending: number;
  private onReady: (() => void)[] = [];

  // Tinted body per skin index (only a handful), and the full per-outfit
  // composite (64×256, all 4 facings). Both memory-only, rebuilt on demand.
  private bodyCache = new Map<number, HTMLCanvasElement>();
  private composites = new Map<string, HTMLCanvasElement>();

  constructor() {
    const urls = [
      bodyUrl,
      ...HAIR.map((p) => p.url),
      ...TOP.map((p) => p.url),
      ...BOTTOM.map((p) => p.url),
      ...ACC.map((p) => p.url).filter((u): u is string => u !== null),
    ];
    this.pending = urls.length;
    for (const url of urls) {
      const img = new Image();
      img.onload = () => {
        this.images.set(url, img);
        this.settle();
      };
      img.onerror = () => {
        console.warn('[character] failed to load layer', url);
        this.settle();
      };
      img.src = url;
    }
  }

  private settle() {
    if (--this.pending > 0) return;
    // Ready only if at least the body loaded; a missing accessory just renders
    // one fewer layer, but without the body there's nothing to draw (circle
    // fallback stays in effect).
    this.ready = this.images.has(bodyUrl);
    const cbs = this.onReady;
    this.onReady = [];
    for (const cb of cbs) cb();
  }

  whenReady(cb: () => void) {
    if (this.ready) cb();
    else this.onReady.push(cb);
  }

  // Base body recolored to a skin tone (multiply tint masked back to the body's
  // alpha), cached per skin index.
  private tintedBody(skin: number): HTMLCanvasElement | null {
    const cached = this.bodyCache.get(skin);
    if (cached) return cached;
    const img = this.images.get(bodyUrl);
    if (!img) return null;
    const c = document.createElement('canvas');
    c.width = FRAME;
    c.height = FRAME * 4;
    const cx = c.getContext('2d');
    if (!cx) return null;
    cx.imageSmoothingEnabled = false;
    cx.drawImage(img, 0, 0);
    const tint = SKIN_TINTS[skin]?.tint ?? null;
    if (tint) {
      cx.globalCompositeOperation = 'multiply';
      cx.fillStyle = tint;
      cx.fillRect(0, 0, FRAME, FRAME * 4);
      // Re-mask to the body silhouette so the multiply rect doesn't tint the
      // transparent margins.
      cx.globalCompositeOperation = 'destination-in';
      cx.drawImage(img, 0, 0);
      cx.globalCompositeOperation = 'source-over';
    }
    this.bodyCache.set(skin, c);
    return c;
  }

  // Composite all layers (body → bottom → top → hair → accessory) for an outfit
  // into a 64×256 sheet, cached by outfit signature. Out-of-range indices just
  // skip their layer, so a stale peer index degrades gracefully.
  private compositeFor(o: Outfit): HTMLCanvasElement | null {
    const key = outfitKey(o);
    const cached = this.composites.get(key);
    if (cached) return cached;
    const body = this.tintedBody(o.skin);
    if (!body) return null;
    const c = document.createElement('canvas');
    c.width = FRAME;
    c.height = FRAME * 4;
    const cx = c.getContext('2d');
    if (!cx) return null;
    cx.imageSmoothingEnabled = false;
    cx.drawImage(body, 0, 0);
    const layerUrls = [BOTTOM[o.bottom]?.url, TOP[o.top]?.url, HAIR[o.hair]?.url, ACC[o.acc]?.url];
    for (const url of layerUrls) {
      if (!url) continue;
      const img = this.images.get(url);
      if (img) cx.drawImage(img, 0, 0);
    }
    this.composites.set(key, c);
    return c;
  }

  /**
   * Draw the composited avatar centered horizontally at `centerX`, with the
   * sprite's feet at `footY`, scaled by `scale`. Returns false (so the caller
   * can fall back) when the sheet isn't ready. `imageSmoothingEnabled` is forced
   * off for crisp pixel art and restored afterward.
   */
  draw(
    ctx: CanvasRenderingContext2D,
    outfit: Outfit,
    dir: Direction,
    centerX: number,
    footY: number,
    scale: number,
  ): boolean {
    if (!this.ready) return false;
    const sheet = this.compositeFor(outfit);
    if (!sheet) return false;
    const row = DIR_ROW[dir];
    const dw = FRAME * scale;
    const dh = FRAME * scale;
    const dx = centerX - dw / 2;
    const dy = footY - dh;
    const prev = ctx.imageSmoothingEnabled;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(sheet, 0, row * FRAME, FRAME, FRAME, dx, dy, dw, dh);
    ctx.imageSmoothingEnabled = prev;
    return true;
  }
}

export { defaultOutfit };
