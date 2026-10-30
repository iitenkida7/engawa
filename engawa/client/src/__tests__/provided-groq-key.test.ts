import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { GROQ_KEY_STORAGE } from '@/media/groq';
import {
  fetchProvidedGroqKey,
  hasProvidedGroqKey,
  loadGroqKey,
  loadStoredGroqKey,
  setProvidedGroqKey,
} from '@/ui/transcript-setup';

// A deployment can hand everyone in the space one transcription key instead of
// each person bringing their own (docs/control-plane.md). These cover which key
// wins, and that the shared one never ends up in this browser's storage.

const STORED = 'gsk_stored_key_abcdefghijkl';
const PROVIDED = 'gsk_provided_key_abcdefghij';

const originalFetch = globalThis.fetch;

// Bun's fetch type carries extras (preconnect) a stub has no use for, so the
// cast goes through unknown.
function stubFetch(impl: () => Promise<Response>) {
  globalThis.fetch = impl as unknown as typeof fetch;
}

function respondWith(body: unknown, ok = true) {
  stubFetch(
    async () =>
      new Response(JSON.stringify(body), {
        status: ok ? 200 : 500,
        headers: { 'Content-Type': 'application/json' },
      }),
  );
}

beforeEach(() => {
  setProvidedGroqKey(null);
  localStorage.clear();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  setProvidedGroqKey(null);
  localStorage.clear();
});

describe('which key transcription uses', () => {
  it('uses the personal key when the space provides none', () => {
    localStorage.setItem(GROQ_KEY_STORAGE, STORED);

    expect(hasProvidedGroqKey()).toBe(false);
    expect(loadGroqKey()).toBe(STORED);
  });

  it("prefers the space's key over a personal one", () => {
    localStorage.setItem(GROQ_KEY_STORAGE, STORED);
    setProvidedGroqKey(PROVIDED);

    expect(loadGroqKey()).toBe(PROVIDED);
    // The personal key is still theirs; it is only outranked.
    expect(loadStoredGroqKey()).toBe(STORED);
  });

  it('lets someone transcribe with no key of their own', () => {
    setProvidedGroqKey(PROVIDED);

    expect(loadGroqKey()).toBe(PROVIDED);
    expect(loadStoredGroqKey()).toBeNull();
  });

  it('ignores a provided value that is not a Groq key', () => {
    setProvidedGroqKey('not-a-key');

    expect(hasProvidedGroqKey()).toBe(false);
    expect(loadGroqKey()).toBeNull();
  });
});

describe('fetchProvidedGroqKey', () => {
  it('adopts the key the server provides', async () => {
    respondWith({ apiKey: PROVIDED });
    await fetchProvidedGroqKey();

    expect(loadGroqKey()).toBe(PROVIDED);
  });

  it('never writes the shared key into this browser', async () => {
    respondWith({ apiKey: PROVIDED });
    await fetchProvidedGroqKey();

    // It belongs to whoever runs the space, not to this browser: it must not
    // outlive the session or follow the user to another deployment.
    expect(localStorage.getItem(GROQ_KEY_STORAGE)).toBeNull();
  });

  it('stays on the personal key when the space provides none', async () => {
    localStorage.setItem(GROQ_KEY_STORAGE, STORED);
    respondWith({ apiKey: null });
    await fetchProvidedGroqKey();

    expect(loadGroqKey()).toBe(STORED);
  });

  it('survives an older server that has no such endpoint', async () => {
    localStorage.setItem(GROQ_KEY_STORAGE, STORED);
    respondWith({}, false);
    await fetchProvidedGroqKey();

    expect(loadGroqKey()).toBe(STORED);
  });

  it('survives a network failure', async () => {
    localStorage.setItem(GROQ_KEY_STORAGE, STORED);
    stubFetch(() => Promise.reject(new Error('offline')));
    await fetchProvidedGroqKey();

    expect(loadGroqKey()).toBe(STORED);
  });
});
