import { describe, expect, it } from 'bun:test';
import {
  ACTIVE_TAB_KEY,
  CLIENT_ID_KEY,
  isSupersededTab,
  loadClientId,
  markActiveTab,
} from '@/core/tab-identity';

function memoryStorage(init: Record<string, string> = {}) {
  const map = new Map(Object.entries(init));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      map.set(k, v);
    },
    map,
  };
}

describe('loadClientId', () => {
  it('mints and saves an id on first use, then reuses it', () => {
    const s = memoryStorage();
    const id = loadClientId(s, () => 'minted-1');
    expect(id).toBe('minted-1');
    expect(s.map.get(CLIENT_ID_KEY)).toBe('minted-1');
    expect(loadClientId(s, () => 'minted-2')).toBe('minted-1');
  });

  it('replaces a malformed stored id', () => {
    const s = memoryStorage({ [CLIENT_ID_KEY]: 'bad id!' });
    expect(loadClientId(s, () => 'fresh')).toBe('fresh');
  });

  it('still returns an id when storage throws or is missing', () => {
    const broken = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    expect(loadClientId(broken, () => 'page-only')).toBe('page-only');
    expect(loadClientId(null, () => 'page-only')).toBe('page-only');
  });
});

describe('isSupersededTab', () => {
  it('is false for the most recently joined tab and before any join', () => {
    const s = memoryStorage();
    expect(isSupersededTab('tab-a', s)).toBe(false);
    markActiveTab('tab-a', s);
    expect(s.map.get(ACTIVE_TAB_KEY)).toBe('tab-a');
    expect(isSupersededTab('tab-a', s)).toBe(false);
  });

  it('is true once another tab has joined', () => {
    const s = memoryStorage();
    markActiveTab('tab-a', s);
    markActiveTab('tab-b', s);
    expect(isSupersededTab('tab-a', s)).toBe(true);
    expect(isSupersededTab('tab-b', s)).toBe(false);
  });
});
