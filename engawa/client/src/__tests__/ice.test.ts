import { afterEach, describe, expect, it } from 'bun:test';
import { fetchIceServers } from '@/rtc/ice';

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('fetchIceServers', () => {
  it('returns the servers issued by /api/turn-credentials', async () => {
    const issued = [{ urls: 'turn:turn.example.com', username: 'u', credential: 'c' }];
    globalThis.fetch = (async () => Response.json(issued)) as unknown as typeof fetch;
    expect(await fetchIceServers('[rtc]')).toEqual(issued);
  });

  it('falls back to public STUN on a network error', async () => {
    globalThis.fetch = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    expect(await fetchIceServers('[rtc]')).toEqual([{ urls: 'stun:stun.l.google.com:19302' }]);
  });

  it('falls back to public STUN when the response is not JSON', async () => {
    globalThis.fetch = (async () => new Response('<html>oops</html>')) as unknown as typeof fetch;
    expect(await fetchIceServers('[sfu]')).toEqual([{ urls: 'stun:stun.l.google.com:19302' }]);
  });
});
