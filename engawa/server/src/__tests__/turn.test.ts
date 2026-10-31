import { afterEach, describe, expect, test } from 'bun:test';
import { applySettings, resetSettings } from '../settings';
import { getTurnCredentials } from '../turn';

// What every failure path has to come back with: a call can still be made
// peer-to-peer without TURN, so a broken upstream must never be fatal.
const STUN_ONLY = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

const CONFIGURED = {
  CLOUDFLARE_TURN_TOKEN_ID: 'turn-key-id',
  CLOUDFLARE_TURN_TOKEN_SECRET: 'turn-key-secret',
};

const realFetch = globalThis.fetch;
const realError = console.error;

type FetchArgs = [input: string, init: RequestInit];
const calls: FetchArgs[] = [];

function stubFetch(reply: () => Promise<Response> | Response) {
  globalThis.fetch = ((input: string, init: RequestInit) => {
    calls.push([String(input), init]);
    return Promise.resolve(reply());
  }) as unknown as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = realFetch;
  console.error = realError;
  calls.length = 0;
  resetSettings();
});

// The failure paths log; keep the test output readable.
function silenceErrors() {
  console.error = () => {};
}

describe('getTurnCredentials', () => {
  test('stays on public STUN when no Cloudflare token is configured', async () => {
    applySettings({ CLOUDFLARE_TURN_TOKEN_ID: null, CLOUDFLARE_TURN_TOKEN_SECRET: null });
    stubFetch(() => Response.json({}));
    expect(await getTurnCredentials()).toEqual(STUN_ONLY);
    expect(calls).toHaveLength(0);
  });

  test('half a credential is no credential', async () => {
    applySettings({ CLOUDFLARE_TURN_TOKEN_ID: 'turn-key-id', CLOUDFLARE_TURN_TOKEN_SECRET: null });
    stubFetch(() => Response.json({}));
    expect(await getTurnCredentials()).toEqual(STUN_ONLY);
    expect(calls).toHaveLength(0);
  });

  test('asks Cloudflare with the secret as a bearer token, never in the answer', async () => {
    applySettings(CONFIGURED);
    stubFetch(() => Response.json({ iceServers: { urls: ['turn:cf'], username: 'u' } }));

    const result = await getTurnCredentials();

    const [url, init] = calls[0];
    expect(url).toContain('/turn/keys/turn-key-id/credentials/generate');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer turn-key-secret');
    // A credential has to outlive the workday tab it was minted for (issue #184).
    expect(JSON.parse(String(init.body))).toEqual({ ttl: 43200 });
    expect(JSON.stringify(result)).not.toContain('turn-key-secret');
  });

  test('wraps the single object Cloudflare returns into the array RTCPeerConnection wants', async () => {
    applySettings(CONFIGURED);
    const iceServers = { urls: ['turn:cf:3478'], username: 'u', credential: 'c' };
    stubFetch(() => Response.json({ iceServers }));
    expect(await getTurnCredentials()).toEqual([iceServers]);
  });

  test('passes an array through untouched', async () => {
    applySettings(CONFIGURED);
    const iceServers = [{ urls: 'turn:a' }, { urls: 'turn:b' }];
    stubFetch(() => Response.json({ iceServers }));
    expect(await getTurnCredentials()).toEqual(iceServers);
  });

  test('falls back to STUN when Cloudflare refuses', async () => {
    applySettings(CONFIGURED);
    silenceErrors();
    stubFetch(() => new Response('nope', { status: 401 }));
    expect(await getTurnCredentials()).toEqual(STUN_ONLY);
  });

  test('falls back to STUN when the answer carries no iceServers', async () => {
    applySettings(CONFIGURED);
    stubFetch(() => Response.json({ result: 'surprise' }));
    expect(await getTurnCredentials()).toEqual(STUN_ONLY);
  });

  test('falls back to STUN when the request itself fails (timeout, DNS, offline)', async () => {
    applySettings(CONFIGURED);
    silenceErrors();
    stubFetch(() => {
      throw new Error('The operation timed out.');
    });
    expect(await getTurnCredentials()).toEqual(STUN_ONLY);
  });

  test('reads the settings per call, so a rotated token takes effect without a restart', async () => {
    applySettings(CONFIGURED);
    stubFetch(() => Response.json({ iceServers: [{ urls: 'turn:cf' }] }));
    await getTurnCredentials();
    applySettings({ ...CONFIGURED, CLOUDFLARE_TURN_TOKEN_SECRET: 'rotated-secret' });
    await getTurnCredentials();

    const auth = calls.map(([, init]) => (init.headers as Record<string, string>).Authorization);
    expect(auth).toEqual(['Bearer turn-key-secret', 'Bearer rotated-secret']);
  });
});
