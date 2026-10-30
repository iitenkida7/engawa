import { describe, expect, test } from 'bun:test';
import {
  createItemStore,
  ITEM_COLS,
  ITEM_MAX,
  ITEM_ROWS,
  normalizeItemId,
  normalizePlacement,
} from '../items';

const place = (col: number, row: number) => ({
  kind: 'chair' as const,
  col,
  row,
  facing: 'down' as const,
});

describe('normalizePlacement', () => {
  test('keeps a valid placement and drops everything else', () => {
    const input = { kind: 'bench', col: 3, row: 4, facing: 'left', extra: 'x' };
    expect(normalizePlacement(input)).toEqual({ kind: 'bench', col: 3, row: 4, facing: 'left' });
  });

  test('rejects unknown kinds and facings', () => {
    expect(normalizePlacement({ kind: 'sofa', col: 1, row: 1, facing: 'up' })).toBeNull();
    expect(normalizePlacement({ kind: 'chair', col: 1, row: 1, facing: 'north' })).toBeNull();
  });

  test('rejects fractional, negative and out-of-map tiles', () => {
    const ok = { kind: 'plant', facing: 'up' };
    expect(normalizePlacement({ ...ok, col: 1.5, row: 1 })).toBeNull();
    expect(normalizePlacement({ ...ok, col: -1, row: 1 })).toBeNull();
    expect(normalizePlacement({ ...ok, col: ITEM_COLS, row: 1 })).toBeNull();
    expect(normalizePlacement({ ...ok, col: 1, row: ITEM_ROWS })).toBeNull();
    expect(normalizePlacement({ ...ok, col: '1', row: 1 })).toBeNull();
    expect(normalizePlacement({ ...ok, col: Number.NaN, row: 1 })).toBeNull();
  });

  test('rejects non-objects', () => {
    expect(normalizePlacement(null)).toBeNull();
    expect(normalizePlacement('x')).toBeNull();
  });
});

describe('normalizeItemId', () => {
  test('accepts short strings only', () => {
    expect(normalizeItemId('abc123')).toBe('abc123');
    expect(normalizeItemId('')).toBeNull();
    expect(normalizeItemId('x'.repeat(33))).toBeNull();
    expect(normalizeItemId(5)).toBeNull();
  });
});

describe('createItemStore', () => {
  test('adds items with server-minted ids and lists them', () => {
    const store = createItemStore();
    const a = store.add(place(1, 1));
    const b = store.add(place(2, 1));
    expect(a?.id).toBeTruthy();
    expect(a?.id).not.toBe(b?.id);
    expect(store.list()).toHaveLength(2);
  });

  test('one item per tile', () => {
    const store = createItemStore();
    expect(store.add(place(1, 1))).not.toBeNull();
    expect(store.add(place(1, 1))).toBeNull();
    expect(store.list()).toHaveLength(1);
  });

  test('removing frees the tile', () => {
    const store = createItemStore();
    const a = store.add(place(1, 1));
    expect(store.remove(a?.id ?? '')).toBe(true);
    expect(store.remove(a?.id ?? '')).toBe(false);
    expect(store.add(place(1, 1))).not.toBeNull();
  });

  test('stops at the cap', () => {
    const store = createItemStore(3);
    for (let i = 0; i < 3; i++) expect(store.add(place(i, 0))).not.toBeNull();
    expect(store.add(place(9, 9))).toBeNull();
    expect(ITEM_MAX).toBeGreaterThan(3);
  });
});
