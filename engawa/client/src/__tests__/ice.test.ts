import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { fetchIceServers, ICE_FETCH_TIMEOUT_MS, ICE_TTL_MS, resetIceCache } from '@/rtc/ice';

function jsonRes(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body } as unknown as Response;
}

describe('fetchIceServers', () => {
  let originalFetch: typeof globalThis.fetch;
  let errSpy: ReturnType<typeof spyOn> | undefined;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    resetIceCache();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    errSpy?.mockRestore();
    errSpy = undefined;
  });

  it('fetches once and serves the cache within the TTL', async () => {
    const servers = [{ urls: 'turn:example' }];
    const f = mock(async () => jsonRes(servers));
    globalThis.fetch = f as unknown as typeof globalThis.fetch;

    let t = 1000;
    const now = () => t;
    expect(await fetchIceServers(now)).toEqual(servers);
    t += ICE_TTL_MS - 1; // still fresh
    expect(await fetchIceServers(now)).toEqual(servers);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('refetches once the TTL has elapsed', async () => {
    const f = mock(async () => jsonRes([{ urls: 'turn:example' }]));
    globalThis.fetch = f as unknown as typeof globalThis.fetch;

    let t = 1000;
    const now = () => t;
    await fetchIceServers(now);
    t += ICE_TTL_MS + 1; // stale
    await fetchIceServers(now);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('dedupes concurrent first calls into one request', async () => {
    let resolve!: (r: Response) => void;
    const f = mock(() => new Promise<Response>((r) => (resolve = r)));
    globalThis.fetch = f as unknown as typeof globalThis.fetch;

    const p1 = fetchIceServers();
    const p2 = fetchIceServers();
    resolve(jsonRes([{ urls: 'turn:x' }]));
    await Promise.all([p1, p2]);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('returns the STUN fallback WITHOUT caching it on error (retries next call)', async () => {
    errSpy = spyOn(console, 'error').mockImplementation(() => {});
    const f = mock(async () => {
      throw new Error('network down');
    });
    globalThis.fetch = f as unknown as typeof globalThis.fetch;

    const first = await fetchIceServers();
    expect(first).toEqual([{ urls: 'stun:stun.l.google.com:19302' }]);

    // A later success is used — the fallback was not latched into the cache.
    const servers = [{ urls: 'turn:recovered' }];
    globalThis.fetch = mock(async () => jsonRes(servers)) as unknown as typeof globalThis.fetch;
    expect(await fetchIceServers()).toEqual(servers);
  });

  it('rejects a non-ok status and a non-array body (STUN fallback)', async () => {
    errSpy = spyOn(console, 'error').mockImplementation(() => {});
    globalThis.fetch = mock(async () =>
      jsonRes({ errorCode: 'unauthorized' }, false, 401),
    ) as unknown as typeof globalThis.fetch;
    expect(await fetchIceServers()).toEqual([{ urls: 'stun:stun.l.google.com:19302' }]);

    resetIceCache();
    globalThis.fetch = mock(async () =>
      jsonRes({ not: 'an array' }),
    ) as unknown as typeof globalThis.fetch;
    expect(await fetchIceServers()).toEqual([{ urls: 'stun:stun.l.google.com:19302' }]);
  });

  it('times out a request that never answers and takes the STUN fallback (issue #194)', async () => {
    errSpy = spyOn(console, 'error').mockImplementation(() => {});
    // Hand the deadline to the test: AbortSignal.timeout returns a signal we
    // abort by hand instead of waiting ICE_FETCH_TIMEOUT_MS in real time.
    const deadlines: number[] = [];
    const ctl = new AbortController();
    const timeoutSpy = spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
      deadlines.push(ms);
      return ctl.signal;
    });
    try {
      // A fetch that hangs until its signal aborts (half-open TCP / stuck proxy).
      globalThis.fetch = mock(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_res, rej) => {
            init?.signal?.addEventListener('abort', () =>
              rej(new DOMException('timed out', 'TimeoutError')),
            );
          }),
      ) as unknown as typeof globalThis.fetch;

      const p = fetchIceServers();
      ctl.abort();
      expect(await p).toEqual([{ urls: 'stun:stun.l.google.com:19302' }]);
      expect(deadlines).toEqual([ICE_FETCH_TIMEOUT_MS]);
    } finally {
      timeoutSpy.mockRestore();
    }
  });
});
