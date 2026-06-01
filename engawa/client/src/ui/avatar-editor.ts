// Character-maker modal (#141, reworked in #144): each category is a header you
// click to expand a grid of every option, picked at a glance instead of stepped
// one-by-one. Part categories (hair/top/shoes/…) render a small front-facing
// avatar per option (the rest of the draft kept, so you see the actual look);
// color categories (skin/hair/cloth) render a color swatch. The composite at top
// previews the chosen look as an 8 FPS walk cycle, 🎲 おまかせ rolls a random one,
// 決定 confirms. The chosen outfit persists to localStorage so it survives a
// reload / re-entry, and an optional onApply callback lets the App relay it to
// peers while in a room.
//
// This is the only owner of the #avatar-editor DOM. It keeps its own
// CharacterSheet for the preview + thumbnails (the image fetches are browser-
// cached, so the renderer's sheet and this one don't double-download).

import {
  CATEGORY_LABELS,
  CharacterSheet,
  colorSwatch,
  LPC_CREDITS_URL,
  OUTFIT_COUNTS,
  optionLabel,
} from '@/world/character';
import {
  defaultOutfit,
  normalizeOutfit,
  OUTFIT_CATEGORIES,
  type Outfit,
  type OutfitCategory,
  randomOutfit,
} from '@/world/outfit';

const STORAGE_KEY = 'engawa-outfit';

// Preview canvas geometry: the 64px source frame drawn at 2× (128px), centered,
// feet near the bottom. The walk cycle runs at 8 FPS (matches upstream preview).
const PREVIEW_SCALE = 2;
const WALK_FPS = 8;

// Thumbnail geometry: a small front-facing standing avatar (col 0) per option.
const THUMB_W = 46;
const THUMB_H = 54;
const THUMB_SCALE = 0.8;

/**
 * Read the persisted outfit, normalized against the current asset counts. With
 * nothing stored yet (first visit) we seed the sensible clothed `defaultOutfit`
 * rather than the all-zeros normalize fallback (which would be a bald, shirt-0
 * look). A stored value is taken as-is and clamped.
 */
export function loadOutfit(): Outfit {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === null) return normalizeOutfit(defaultOutfit(), OUTFIT_COUNTS);
  let raw: unknown = null;
  try {
    raw = JSON.parse(stored);
  } catch {
    raw = null;
  }
  return normalizeOutfit(raw, OUTFIT_COUNTS);
}

function saveOutfit(o: Outfit) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(o));
}

type CategoryUI = {
  current: HTMLSpanElement;
  swatch: HTMLSpanElement;
  chevron: HTMLSpanElement;
  grid: HTMLDivElement;
  cells: HTMLButtonElement[];
};

export class AvatarEditor {
  private sheet: CharacterSheet;
  private overlay: HTMLDivElement;
  private preview: HTMLCanvasElement;
  private cats = new Map<OutfitCategory, CategoryUI>();
  private draft: Outfit = loadOutfit();
  private applyCb: ((o: Outfit) => void) | null = null;
  private animId: number | null = null;
  private openCat: OutfitCategory | null = null;
  // Thumbnails currently scrolled into view (lazy-painted; repainted when a
  // composite finishes building so a pending tile fills in once ready).
  private visibleThumbs = new Set<HTMLCanvasElement>();
  private observer: IntersectionObserver;

  constructor() {
    this.overlay = document.getElementById('avatar-editor') as HTMLDivElement;
    this.preview = document.getElementById('avatar-preview') as HTMLCanvasElement;
    const list = document.getElementById('avatar-categories') as HTMLDivElement;

    // Repaint visible thumbnails whenever a composite finishes building.
    this.sheet = new CharacterSheet(() => this.repaintThumbs());

    // Lazy-build thumbnails: only cells scrolled into view composite, so opening
    // a large grid (hair has 100+ options) stays responsive. Cells of a hidden
    // (collapsed) grid never intersect, so nothing builds until expanded.
    this.observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const canvas = e.target as HTMLCanvasElement;
          if (e.isIntersecting) {
            this.visibleThumbs.add(canvas);
            this.paintThumb(canvas);
          } else {
            this.visibleThumbs.delete(canvas);
          }
        }
      },
      { root: list, rootMargin: '120px' },
    );

    for (const cat of OUTFIT_CATEGORIES) this.buildCategory(list, cat);

    (document.getElementById('avatar-random') as HTMLButtonElement).addEventListener(
      'click',
      () => {
        this.draft = randomOutfit(OUTFIT_COUNTS);
        this.updateHeads();
        if (this.openCat) this.updateSelected(this.openCat);
        this.repaintThumbs();
      },
    );
    (document.getElementById('avatar-apply') as HTMLButtonElement).addEventListener('click', () =>
      this.apply(),
    );
    (document.getElementById('avatar-cancel') as HTMLButtonElement).addEventListener('click', () =>
      this.close(),
    );
    const credits = document.getElementById('avatar-credits') as HTMLAnchorElement;
    credits.href = LPC_CREDITS_URL;
  }

  /** Build one collapsible category: a clickable header + a hidden options grid. */
  private buildCategory(list: HTMLDivElement, cat: OutfitCategory) {
    const wrap = document.createElement('div');
    wrap.className = 'avatar-cat';

    const head = document.createElement('button');
    head.type = 'button';
    head.className = 'avatar-cat-head';

    const label = document.createElement('span');
    label.className = 'avatar-cat-label';
    label.textContent = CATEGORY_LABELS[cat];

    const swatch = document.createElement('span');
    swatch.className = 'avatar-swatch';
    swatch.style.display = 'none';

    const current = document.createElement('span');
    current.className = 'avatar-cat-current';

    const chevron = document.createElement('span');
    chevron.className = 'avatar-cat-chevron';
    chevron.textContent = '▾';

    head.append(label, swatch, current, chevron);
    head.addEventListener('click', () => this.toggle(cat));

    const grid = document.createElement('div');
    grid.className = 'avatar-grid hidden';

    // Color categories (skin / hair / cloth) show a swatch; part categories show
    // a mini avatar wearing that option. colorSwatch() is the discriminator.
    const isColor = colorSwatch(cat, 0) !== null;
    const cells: HTMLButtonElement[] = [];
    const count = OUTFIT_COUNTS[cat];
    for (let i = 0; i < count; i++) {
      const cell = document.createElement('button');
      cell.type = 'button';
      cell.className = 'avatar-cell';
      cell.title = optionLabel(cat, i);

      if (isColor) {
        const sw = document.createElement('span');
        sw.className = 'avatar-cell-swatch';
        sw.style.background = colorSwatch(cat, i) ?? '#000';
        cell.appendChild(sw);
      } else {
        const canvas = document.createElement('canvas');
        canvas.className = 'avatar-thumb';
        canvas.width = THUMB_W;
        canvas.height = THUMB_H;
        canvas.dataset.cat = cat;
        canvas.dataset.index = String(i);
        cell.appendChild(canvas);
        this.observer.observe(canvas);
      }

      const cl = document.createElement('span');
      cl.className = 'avatar-cell-label';
      cl.textContent = optionLabel(cat, i);
      cell.appendChild(cl);

      cell.addEventListener('click', () => this.choose(cat, i));
      cells.push(cell);
      grid.appendChild(cell);
    }

    wrap.append(head, grid);
    list.appendChild(wrap);
    this.cats.set(cat, { current, swatch, chevron, grid, cells });
  }

  /** The persisted outfit (what to send on join). */
  getOutfit(): Outfit {
    return loadOutfit();
  }

  open(opts?: { onApply?: (o: Outfit) => void }) {
    this.applyCb = opts?.onApply ?? null;
    this.draft = loadOutfit();
    this.overlay.classList.remove('hidden');
    if (this.openCat) this.setOpen(this.openCat, false);
    this.openCat = null;
    this.updateHeads();
    this.startAnim();
  }

  private close() {
    this.overlay.classList.add('hidden');
    this.applyCb = null;
    this.stopAnim();
  }

  private apply() {
    saveOutfit(this.draft);
    this.applyCb?.(this.draft);
    this.close();
  }

  /** Expand the clicked category (collapsing any other — accordion). */
  private toggle(cat: OutfitCategory) {
    if (this.openCat === cat) {
      this.setOpen(cat, false);
      this.openCat = null;
      return;
    }
    if (this.openCat) this.setOpen(this.openCat, false);
    this.openCat = cat;
    this.setOpen(cat, true);
  }

  private setOpen(cat: OutfitCategory, open: boolean) {
    const u = this.cats.get(cat);
    if (!u) return;
    u.grid.classList.toggle('hidden', !open);
    u.chevron.textContent = open ? '▴' : '▾';
    if (open) {
      this.updateSelected(cat);
      // Bring the expanded grid into view (the list scrolls when tall).
      u.grid.scrollIntoView({ block: 'nearest' });
    }
  }

  /** Pick an option: update the draft, the header, and the selected highlight. */
  private choose(cat: OutfitCategory, index: number) {
    this.draft = { ...this.draft, [cat]: index };
    this.updateHeads();
    this.updateSelected(cat);
    this.repaintThumbs();
  }

  /** Highlight the cell matching the current draft for an (open) category. */
  private updateSelected(cat: OutfitCategory) {
    const u = this.cats.get(cat);
    if (!u) return;
    u.cells.forEach((cell, i) => {
      cell.classList.toggle('selected', i === this.draft[cat]);
    });
  }

  /** Refresh every category header's current-option name + color chip. */
  private updateHeads() {
    for (const cat of OUTFIT_CATEGORIES) {
      const u = this.cats.get(cat);
      if (!u) continue;
      u.current.textContent = optionLabel(cat, this.draft[cat]);
      const hex = colorSwatch(cat, this.draft[cat]);
      if (hex) {
        u.swatch.style.display = 'inline-block';
        u.swatch.style.background = hex;
      } else {
        u.swatch.style.display = 'none';
      }
    }
  }

  /** Draw one thumbnail: the avatar wearing this cell's option (draft + override). */
  private paintThumb(canvas: HTMLCanvasElement) {
    const cat = canvas.dataset.cat as OutfitCategory;
    const index = Number(canvas.dataset.index);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const variant = { ...this.draft, [cat]: index } as Outfit;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    this.sheet.draw(ctx, variant, 'down', 0, canvas.width / 2, canvas.height - 1, THUMB_SCALE);
  }

  private repaintThumbs() {
    for (const c of this.visibleThumbs) this.paintThumb(c);
  }

  private startAnim() {
    if (this.animId !== null) return;
    const loop = () => {
      this.paint();
      this.animId = requestAnimationFrame(loop);
    };
    this.animId = requestAnimationFrame(loop);
  }

  private stopAnim() {
    if (this.animId !== null) {
      cancelAnimationFrame(this.animId);
      this.animId = null;
    }
  }

  /** Paint one preview frame: face the viewer, looping the walk cycle (cols 1–8). */
  private paint() {
    const ctx = this.preview.getContext('2d');
    if (!ctx) return;
    const w = this.preview.width;
    const h = this.preview.height;
    ctx.clearRect(0, 0, w, h);
    const col = 1 + (Math.floor(performance.now() / (1000 / WALK_FPS)) % 8);
    this.sheet.draw(ctx, this.draft, 'down', col, w / 2, h - 8, PREVIEW_SCALE);
  }
}
