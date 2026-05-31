// Character-maker modal (#141): step each category with ◀ / ▶ (or the wheel),
// preview the composite live as an 8 FPS walk cycle, 🎲 おまかせ for a random
// look, 決定 to confirm. The chosen outfit persists to localStorage so it
// survives a reload / re-entry, and an optional onApply callback lets the App
// relay it to peers while in a room.
//
// This is the only owner of the #avatar-editor DOM. It keeps its own
// CharacterSheet for the preview (the image fetches are browser-cached, so the
// renderer's sheet and this one don't double-download).

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
  wrapIndex,
} from '@/world/outfit';

const STORAGE_KEY = 'engawa-outfit';

// Preview canvas geometry: the 64px source frame drawn at 2× (128px), centered,
// feet near the bottom. The walk cycle runs at 8 FPS (matches upstream preview).
const PREVIEW_SCALE = 2;
const WALK_FPS = 8;

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

export class AvatarEditor {
  private sheet = new CharacterSheet();
  private overlay: HTMLDivElement;
  private preview: HTMLCanvasElement;
  private valueLabels = new Map<OutfitCategory, HTMLSpanElement>();
  private swatches = new Map<OutfitCategory, HTMLSpanElement>();
  private draft: Outfit = loadOutfit();
  private applyCb: ((o: Outfit) => void) | null = null;
  private animId: number | null = null;

  constructor() {
    this.overlay = document.getElementById('avatar-editor') as HTMLDivElement;
    this.preview = document.getElementById('avatar-preview') as HTMLCanvasElement;
    const list = document.getElementById('avatar-categories') as HTMLDivElement;

    for (const cat of OUTFIT_CATEGORIES) {
      const row = document.createElement('div');
      row.className = 'avatar-row';

      const label = document.createElement('span');
      label.className = 'avatar-row-label';
      label.textContent = CATEGORY_LABELS[cat];

      const prev = document.createElement('button');
      prev.type = 'button';
      prev.className = 'avatar-step';
      prev.textContent = '◀';
      prev.addEventListener('click', () => this.step(cat, -1));

      // Color chip (shown only for color categories), then the option name.
      const swatch = document.createElement('span');
      swatch.className = 'avatar-swatch';
      swatch.style.cssText =
        'display:none;width:14px;height:14px;border-radius:3px;border:1px solid rgba(0,0,0,.35);vertical-align:middle;margin-right:4px';
      this.swatches.set(cat, swatch);

      const value = document.createElement('span');
      value.className = 'avatar-row-value';
      this.valueLabels.set(cat, value);

      const next = document.createElement('button');
      next.type = 'button';
      next.className = 'avatar-step';
      next.textContent = '▶';
      next.addEventListener('click', () => this.step(cat, 1));

      // Wheel over a row cycles that category (the issue's "ホイールで送る").
      row.addEventListener('wheel', (e) => {
        e.preventDefault();
        this.step(cat, e.deltaY > 0 ? 1 : -1);
      });

      row.append(label, prev, swatch, value, next);
      list.appendChild(row);
    }

    (document.getElementById('avatar-random') as HTMLButtonElement).addEventListener(
      'click',
      () => {
        this.draft = randomOutfit(OUTFIT_COUNTS);
        this.updateLabels();
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

  /** The persisted outfit (what to send on join). */
  getOutfit(): Outfit {
    return loadOutfit();
  }

  open(opts?: { onApply?: (o: Outfit) => void }) {
    this.applyCb = opts?.onApply ?? null;
    this.draft = loadOutfit();
    this.overlay.classList.remove('hidden');
    this.updateLabels();
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

  private step(cat: OutfitCategory, delta: number) {
    this.draft = { ...this.draft, [cat]: wrapIndex(this.draft[cat] + delta, OUTFIT_COUNTS[cat]) };
    this.updateLabels();
  }

  /** Refresh the per-row option name + color chip (cheap; on change only). */
  private updateLabels() {
    for (const cat of OUTFIT_CATEGORIES) {
      const span = this.valueLabels.get(cat);
      if (span) span.textContent = optionLabel(cat, this.draft[cat]);
      const sw = this.swatches.get(cat);
      if (sw) {
        const hex = colorSwatch(cat, this.draft[cat]);
        if (hex) {
          sw.style.display = 'inline-block';
          sw.style.background = hex;
        } else {
          sw.style.display = 'none';
        }
      }
    }
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
