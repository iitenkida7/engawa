// Pure, side-effect-free avatar-outfit logic for the modular LPC avatar (#141).
// Deliberately free of any Image/canvas/Vite-asset import so it can run under
// `bun test` and be shared by the renderer, the avatar editor, and PlayerState.
// The actual layered part sheets + per-category counts live in the manifest
// (loaded by world/character.ts); this module takes the counts as data so it
// stays pure.

// One avatar configuration: an integer index per category. The type itself is
// part of the wire protocol (the server relays outfits), so it lives in
// shared/protocol.ts — re-exported here because this module is the home of all
// outfit logic.
import type { Outfit } from '@shared/protocol';

export type { Outfit };

// The number of options available in each category. Supplied by character.ts
// (the manifest source of truth) so this module never hard-codes counts.
export type OutfitCounts = Record<keyof Outfit, number>;

export const OUTFIT_CATEGORIES = [
  'sex',
  'skin',
  'hair',
  'hairColor',
  'top',
  'topColor',
  'bottom',
  'bottomColor',
  'shoes',
  'hat',
  'glasses',
] as const;
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

/**
 * A sensible default look (a clothed office worker), not all-zeros: index 0 of
 * `hair` is "none", so we pick the first real hair, and dress in muted colors.
 * Every index is still clamped by normalizeOutfit against the live counts.
 */
export function defaultOutfit(): Outfit {
  return {
    sex: 0,
    skin: 0,
    hair: 1,
    hairColor: 0,
    top: 0,
    topColor: 4,
    bottom: 0,
    bottomColor: 2,
    shoes: 1,
    hat: 0,
    glasses: 0,
  };
}

/**
 * Coerce an arbitrary value into a valid Outfit by clamping each category index
 * into its [0, count) range. Missing / garbage fields fall back to 0, so a
 * stored or peer-sent outfit always renders something.
 */
export function normalizeOutfit(raw: unknown, counts: OutfitCounts): Outfit {
  const o = (raw ?? {}) as Partial<Record<keyof Outfit, unknown>>;
  return {
    sex: clampIndex(o.sex, counts.sex),
    skin: clampIndex(o.skin, counts.skin),
    hair: clampIndex(o.hair, counts.hair),
    hairColor: clampIndex(o.hairColor, counts.hairColor),
    top: clampIndex(o.top, counts.top),
    topColor: clampIndex(o.topColor, counts.topColor),
    bottom: clampIndex(o.bottom, counts.bottom),
    bottomColor: clampIndex(o.bottomColor, counts.bottomColor),
    shoes: clampIndex(o.shoes, counts.shoes),
    hat: clampIndex(o.hat, counts.hat),
    glasses: clampIndex(o.glasses, counts.glasses),
  };
}

/**
 * A random outfit (the "🎲 おまかせ" button). The random source is injectable so
 * the result is deterministic in tests; each category gets an index in its range.
 */
export function randomOutfit(counts: OutfitCounts, rand: () => number = Math.random): Outfit {
  const pick = (count: number) => wrapIndex(Math.floor(rand() * count), count);
  return {
    sex: pick(counts.sex),
    skin: pick(counts.skin),
    hair: pick(counts.hair),
    hairColor: pick(counts.hairColor),
    top: pick(counts.top),
    topColor: pick(counts.topColor),
    bottom: pick(counts.bottom),
    bottomColor: pick(counts.bottomColor),
    shoes: pick(counts.shoes),
    hat: pick(counts.hat),
    glasses: pick(counts.glasses),
  };
}
