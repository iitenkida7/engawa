import { describe, expect, test } from 'bun:test';
import {
  clearEntryToken,
  ENTRY_TOKEN_KEY,
  ENTRY_TOKEN_MAX_LENGTH,
  loadEntryToken,
  pickEntryToken,
  sanitizeEntryToken,
  storeEntryToken,
  urlWithoutEntryToken,
} from '@/core/entry-token';

const TOKEN = 'eyJ1c2VySWQiOiJ1XzEifQ.c2lnbmF0dXJl';
const OTHER = 'eyJ1c2VySWQiOiJ1XzIifQ.YW5vdGhlcg';

/** Minimal in-memory stand-in for localStorage. */
function fakeStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    get size() {
      return map.size;
    },
  };
}

/** A storage that throws on every access (blocked site data / private mode). */
const brokenStorage = {
  getItem: () => {
    throw new Error('blocked');
  },
  setItem: () => {
    throw new Error('blocked');
  },
  removeItem: () => {
    throw new Error('blocked');
  },
};

describe('sanitizeEntryToken', () => {
  test('accepts a <payload>.<signature> pair and trims it', () => {
    expect(sanitizeEntryToken(TOKEN)).toBe(TOKEN);
    expect(sanitizeEntryToken(`  ${TOKEN}\n`)).toBe(TOKEN);
  });

  test('rejects anything that could not verify anyway', () => {
    for (const raw of ['', '   ', 'nodot', '.sig', 'payload.', 'a.b.c', 'bad chars.sig', 'a.b!']) {
      expect(sanitizeEntryToken(raw)).toBeNull();
    }
  });

  test('rejects a missing value or a non-string', () => {
    expect(sanitizeEntryToken(null)).toBeNull();
    expect(sanitizeEntryToken(undefined)).toBeNull();
  });

  test('rejects an oversized value rather than storing it', () => {
    expect(sanitizeEntryToken(`${'a'.repeat(ENTRY_TOKEN_MAX_LENGTH)}.b`)).toBeNull();
  });
});

describe('pickEntryToken', () => {
  test('the ticket in the link wins over a saved one', () => {
    // Following a fresh link must replace a stale ticket, not be ignored by it.
    expect(pickEntryToken(TOKEN, OTHER)).toBe(TOKEN);
  });

  test('falls back to the saved ticket on an ordinary reload', () => {
    expect(pickEntryToken(null, OTHER)).toBe(OTHER);
  });

  test('a junk ticket in the link does not shadow a good saved one', () => {
    expect(pickEntryToken('garbage', OTHER)).toBe(OTHER);
  });

  test('nothing usable anywhere is null', () => {
    expect(pickEntryToken(null, null)).toBeNull();
    expect(pickEntryToken('garbage', 'also-garbage')).toBeNull();
  });
});

describe('urlWithoutEntryToken', () => {
  test('strips the ticket and keeps everything else', () => {
    expect(urlWithoutEntryToken(`https://office.example/?t=${TOKEN}&lang=ja#here`)).toBe(
      'https://office.example/?lang=ja#here',
    );
  });

  test('leaves the only query parameter behind as a bare path', () => {
    expect(urlWithoutEntryToken(`https://office.example/?t=${TOKEN}`)).toBe(
      'https://office.example/',
    );
  });

  test('null when there is nothing to strip, so no history entry is rewritten', () => {
    expect(urlWithoutEntryToken('https://office.example/?lang=ja')).toBeNull();
    expect(urlWithoutEntryToken('https://office.example/')).toBeNull();
    expect(urlWithoutEntryToken('not a url')).toBeNull();
  });
});

describe('storage', () => {
  test('round-trips a ticket', () => {
    const storage = fakeStorage();
    storeEntryToken(TOKEN, storage);
    expect(storage.getItem(ENTRY_TOKEN_KEY)).toBe(TOKEN);
    expect(loadEntryToken(storage)).toBe(TOKEN);
  });

  test('clearing it leaves nothing behind', () => {
    const storage = fakeStorage({ [ENTRY_TOKEN_KEY]: TOKEN });
    clearEntryToken(storage);
    expect(loadEntryToken(storage)).toBeNull();
    expect(storage.size).toBe(0);
  });

  test('a corrupted saved value reads as no ticket', () => {
    expect(loadEntryToken(fakeStorage({ [ENTRY_TOKEN_KEY]: 'garbage' }))).toBeNull();
  });

  test('storage that throws is treated as no storage, not a broken join', () => {
    expect(loadEntryToken(brokenStorage)).toBeNull();
    expect(() => storeEntryToken(TOKEN, brokenStorage)).not.toThrow();
    expect(() => clearEntryToken(brokenStorage)).not.toThrow();
  });

  test('no storage at all is handled', () => {
    expect(loadEntryToken(null)).toBeNull();
    expect(() => storeEntryToken(TOKEN, null)).not.toThrow();
    expect(() => clearEntryToken(null)).not.toThrow();
  });
});
