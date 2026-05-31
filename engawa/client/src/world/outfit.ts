// Pure, side-effect-free avatar-outfit logic for the modular LPC avatar (#141).
// Deliberately free of any Image/canvas/Vite-asset import so it can run under
// `bun test` and be shared by the renderer, the avatar editor, and PlayerState.
// The actual part images + per-category counts live in world/character.ts (Vite
// `?url` imports); this module takes the counts as data so it stays pure.

// One avatar configuration: an integer index per category. A handful of small
// numbers — exactly what the issue calls for — so the whole thing relays as JSON
// and the server can stay stateless (invariant #2).
export type Outfit = {
  // Skin tone (a multiply tint applied to the single base body sheet).
  skin: number;
  hair: number;
  top: number;
  bottom: number;
  // Accessory (index 0 is "none").
  acc: number;
};

// The number of options available in each category. Supplied by character.ts
// (the asset source of truth) so this module never hard-codes asset counts.
export type OutfitCounts = Record<keyof Outfit, number>;

export const OUTFIT_CATEGORIES = ['skin', 'hair', 'top', 'bottom', 'acc'] as const;
export type OutfitCategory = (typeof OUTFIT_CATEGORIES)[number];

// The four facings an avatar can show, picked from its velocity. Lives here (a
// DOM-free module) so PlayerState can hold it without importing the asset layer.
export type Direction = 'up' | 'left' | 'down' | 'right';

/**
 * Wrap an index into [0, len) with a positive modulo, so stepping a category
 * with ◀ / ▶ (or the wheel) cycles round in both directions. A non-positive or
 * non-finite `len` yields 0 (nothing to choose from).
 */
export function wrapIndex(i: number, len: number): number {
  if (!Number.isFinite(len) || len <= 0) return 0;
  const n = Math.trunc(i) % len;
  return n < 0 ? n + len : n;
}

/** Clamp one index into [0, count): out-of-range / non-finite collapses to 0. */
function clampIndex(v: unknown, count: number): number {
  const n = Math.trunc(Number(v));
  if (!Number.isFinite(n) || n < 0) return 0;
  if (count <= 0) return 0;
  return n >= count ? count - 1 : n;
}

/** The all-defaults outfit (index 0 in every category). */
export function defaultOutfit(): Outfit {
  return { skin: 0, hair: 0, top: 0, bottom: 0, acc: 0 };
}

/**
 * Coerce an arbitrary value into a valid Outfit by clamping each category index
 * into its [0, count) range. Missing / garbage fields fall back to 0, so a
 * stored or peer-sent outfit always renders something.
 */
export function normalizeOutfit(raw: unknown, counts: OutfitCounts): Outfit {
  const o = (raw ?? {}) as Partial<Record<keyof Outfit, unknown>>;
  return {
    skin: clampIndex(o.skin, counts.skin),
    hair: clampIndex(o.hair, counts.hair),
    top: clampIndex(o.top, counts.top),
    bottom: clampIndex(o.bottom, counts.bottom),
    acc: clampIndex(o.acc, counts.acc),
  };
}

/**
 * A random outfit (the "🎲 おまかせ" button). The random source is injectable so
 * the result is deterministic in tests; each category gets an index in its range.
 */
export function randomOutfit(counts: OutfitCounts, rand: () => number = Math.random): Outfit {
  const pick = (count: number) => wrapIndex(Math.floor(rand() * count), count);
  return {
    skin: pick(counts.skin),
    hair: pick(counts.hair),
    top: pick(counts.top),
    bottom: pick(counts.bottom),
    acc: pick(counts.acc),
  };
}
