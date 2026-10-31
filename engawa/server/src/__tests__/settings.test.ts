import { afterEach, describe, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import {
  applySettings,
  fetchSettings,
  isAcceptableControlPlaneUrl,
  normalizeIntervalSeconds,
  parseSettings,
  resetSettings,
  setting,
  settingsEnv,
  verifySettingsSignature,
} from '../settings';

afterEach(() => resetSettings());

describe('parseSettings', () => {
  test('keeps known keys', () => {
    expect(parseSettings({ ACCESS_PASSWORD: 'hunter22' })).toEqual({ ACCESS_PASSWORD: 'hunter22' });
  });

  test('drops unknown keys rather than failing', () => {
    // Forward compatibility: an older server must survive a newer control plane.
    expect(parseSettings({ ACCESS_PASSWORD: 'x', SOMETHING_NEW: 'y' })).toEqual({
      ACCESS_PASSWORD: 'x',
    });
  });

  test('never lets a control plane set boot-time variables', () => {
    expect(parseSettings({ PORT: '9999', MAP: 'https://evil.example/map.json' })).toEqual({});
  });

  test('coerces numbers and booleans to strings', () => {
    expect(parseSettings({ SFU_PROMOTE_AT: 4, EVENT_INCLUDE_NAMES: true })).toEqual({
      SFU_PROMOTE_AT: '4',
      EVENT_INCLUDE_NAMES: 'true',
    });
  });

  test('null and empty string mean explicitly unset', () => {
    expect(parseSettings({ ACCESS_PASSWORD: null, CLOUDFLARE_TURN_TOKEN_ID: '' })).toEqual({
      ACCESS_PASSWORD: null,
      CLOUDFLARE_TURN_TOKEN_ID: null,
    });
  });

  test('ignores values of a shape we cannot use', () => {
    expect(parseSettings({ ACCESS_PASSWORD: { nested: true }, SFU_PROMOTE_AT: [1] })).toEqual({});
  });

  test('a non-object response yields no settings', () => {
    for (const raw of [null, undefined, 'nope', 42, ['a']]) {
      expect(parseSettings(raw)).toEqual({});
    }
  });
});

describe('setting', () => {
  const env = { ACCESS_PASSWORD: 'from-env', CLOUDFLARE_TURN_TOKEN_ID: 'env-id' };

  test('falls back to the environment when the control plane is silent', () => {
    expect(setting('ACCESS_PASSWORD', env)).toBe('from-env');
  });

  test('the control plane wins over the environment', () => {
    applySettings({ ACCESS_PASSWORD: 'from-control-plane' });
    expect(setting('ACCESS_PASSWORD', env)).toBe('from-control-plane');
  });

  test('an explicit null clears a value the environment still has', () => {
    // The hosted case: the image ships with a password baked into env and the
    // customer turns the password off. Without this it could never be cleared.
    applySettings({ ACCESS_PASSWORD: null });
    expect(setting('ACCESS_PASSWORD', env)).toBeUndefined();
  });

  test('a key the control plane did not mention keeps its env value', () => {
    applySettings({ ACCESS_PASSWORD: null });
    expect(setting('CLOUDFLARE_TURN_TOKEN_ID', env)).toBe('env-id');
  });

  test('applying new settings replaces the previous ones wholesale', () => {
    applySettings({ ACCESS_PASSWORD: 'first' });
    applySettings({ CLOUDFLARE_TURN_TOKEN_ID: 'second' });
    expect(setting('ACCESS_PASSWORD', env)).toBe('from-env');
    expect(setting('CLOUDFLARE_TURN_TOKEN_ID', env)).toBe('second');
  });
});

describe('settingsEnv', () => {
  test('merges overrides over the environment', () => {
    applySettings({ EVENT_WEBHOOK_URL: 'https://hooks.example/x', ACCESS_PASSWORD: null });
    const merged = settingsEnv({ ACCESS_PASSWORD: 'from-env', PORT: '3000' });

    expect(merged.EVENT_WEBHOOK_URL).toBe('https://hooks.example/x');
    expect(merged.ACCESS_PASSWORD).toBeUndefined();
    expect(merged.PORT).toBe('3000');
  });
});

describe('normalizeIntervalSeconds', () => {
  test('defaults when unset or unparseable', () => {
    expect(normalizeIntervalSeconds(undefined)).toBe(60);
    expect(normalizeIntervalSeconds('')).toBe(60);
    expect(normalizeIntervalSeconds('often')).toBe(60);
  });

  test('floors the interval so a typo cannot hammer the control plane', () => {
    expect(normalizeIntervalSeconds('0')).toBe(10);
    expect(normalizeIntervalSeconds('-5')).toBe(10);
  });

  test('honours a sensible value', () => {
    expect(normalizeIntervalSeconds('300')).toBe(300);
  });
});

describe('isAcceptableControlPlaneUrl', () => {
  test('accepts https', () => {
    expect(isAcceptableControlPlaneUrl('https://control.example/settings')).toBe(true);
  });

  test('rejects plain http, which would put credentials on the wire', () => {
    expect(isAcceptableControlPlaneUrl('http://control.example/settings')).toBe(false);
  });

  test('allows http against localhost, where there is no wire', () => {
    expect(isAcceptableControlPlaneUrl('http://localhost:8000/settings')).toBe(true);
    expect(isAcceptableControlPlaneUrl('http://127.0.0.1:8000/settings')).toBe(true);
  });

  test('rejects anything that is not a URL', () => {
    expect(isAcceptableControlPlaneUrl('')).toBe(false);
    expect(isAcceptableControlPlaneUrl('control.example')).toBe(false);
    expect(isAcceptableControlPlaneUrl('file:///etc/passwd')).toBe(false);
  });
});

describe('verifySettingsSignature', () => {
  const secret = 'tenant-token';
  const body = '{"ACCESS_PASSWORD":"hunter22"}';
  const sign = (b: string, s: string) =>
    `sha256=${createHmac('sha256', s).update(b).digest('hex')}`;

  test('accepts a signature made with our token', () => {
    expect(verifySettingsSignature(body, sign(body, secret), secret)).toBe(true);
  });

  test('rejects one made with a different token', () => {
    expect(verifySettingsSignature(body, sign(body, 'someone-elses'), secret)).toBe(false);
  });

  test('rejects a signature for different bytes', () => {
    expect(verifySettingsSignature(body, sign('{"ACCESS_PASSWORD":""}', secret), secret)).toBe(
      false,
    );
  });

  test('rejects a missing or malformed header', () => {
    expect(verifySettingsSignature(body, null, secret)).toBe(false);
    expect(verifySettingsSignature(body, '', secret)).toBe(false);
    expect(verifySettingsSignature(body, 'sha256=nope', secret)).toBe(false);
  });
});

describe('fetchSettings', () => {
  const originalFetch = globalThis.fetch;
  const TOKEN = 'tenant-token';
  const env = { CONTROL_PLANE_URL: 'https://control.example/settings' };
  const signed = { ...env, CONTROL_PLANE_TOKEN: TOKEN };

  function signedResponse(payload: unknown, secret = TOKEN): Response {
    const body = JSON.stringify(payload);
    return new Response(body, {
      headers: {
        'content-type': 'application/json',
        'x-engawa-signature': `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`,
      },
    });
  }

  // Bun's fetch type carries extras a stub has no use for, so the cast goes
  // through unknown.
  function stubFetch(impl: (url: string, init?: RequestInit) => Promise<Response>) {
    globalThis.fetch = impl as unknown as typeof fetch;
  }

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('does nothing without a control plane', async () => {
    let called = false;
    stubFetch(async () => {
      called = true;
      return new Response('{}');
    });

    expect(await fetchSettings({})).toBe(false);
    expect(called).toBe(false);
  });

  test('applies what the control plane returns', async () => {
    stubFetch(async () => Response.json({ ACCESS_PASSWORD: 'from-control-plane' }));

    expect(await fetchSettings(env)).toBe(true);
    expect(setting('ACCESS_PASSWORD', {})).toBe('from-control-plane');
  });

  test('sends the bearer token only when one is configured', async () => {
    let seen: string | null = 'unset';
    stubFetch(async (_url, init) => {
      seen = new Headers(init?.headers).get('authorization');
      return signedResponse({});
    });

    await fetchSettings(env);
    expect(seen).toBeNull();

    await fetchSettings(signed);
    expect(seen).toBe(`Bearer ${TOKEN}`);
  });

  test('refuses settings whose signature does not verify', async () => {
    applySettings({ ACCESS_PASSWORD: 'still-good' });
    // A perfectly well-formed response from someone who does not hold the
    // token. That it looks valid is exactly what makes it dangerous.
    stubFetch(async () => signedResponse({ ACCESS_PASSWORD: 'attacker' }, 'wrong-token'));

    expect(await fetchSettings(signed)).toBe(false);
    expect(setting('ACCESS_PASSWORD', {})).toBe('still-good');
  });

  test('refuses settings with no signature at all', async () => {
    applySettings({ ACCESS_PASSWORD: 'still-good' });
    stubFetch(async () => Response.json({ ACCESS_PASSWORD: 'attacker' }));

    expect(await fetchSettings(signed)).toBe(false);
    expect(setting('ACCESS_PASSWORD', {})).toBe('still-good');
  });

  test('accepts a correctly signed response', async () => {
    stubFetch(async () => signedResponse({ ACCESS_PASSWORD: 'from-control-plane' }));

    expect(await fetchSettings(signed)).toBe(true);
    expect(setting('ACCESS_PASSWORD', {})).toBe('from-control-plane');
  });

  test('will not fetch over plain http', async () => {
    let called = false;
    stubFetch(async () => {
      called = true;
      return signedResponse({});
    });

    expect(await fetchSettings({ CONTROL_PLANE_URL: 'http://control.example/settings' })).toBe(
      false,
    );
    expect(called).toBe(false);
  });

  test('keeps the previous settings when the control plane errors', async () => {
    applySettings({ ACCESS_PASSWORD: 'still-good' });
    stubFetch(async () => new Response('nope', { status: 500 }));

    expect(await fetchSettings(env)).toBe(false);
    // An office that is running correctly must not lose its settings because
    // the control plane had a bad minute.
    expect(setting('ACCESS_PASSWORD', {})).toBe('still-good');
  });

  test('keeps the previous settings when the fetch throws', async () => {
    applySettings({ CLOUDFLARE_TURN_TOKEN_ID: 'still-good' });
    stubFetch(() => Promise.reject(new Error('unreachable')));

    expect(await fetchSettings(env)).toBe(false);
    expect(setting('CLOUDFLARE_TURN_TOKEN_ID', {})).toBe('still-good');
  });

  test('keeps the previous settings when the body is not JSON', async () => {
    applySettings({ ACCESS_PASSWORD: 'still-good' });
    stubFetch(async () => new Response('<html>oops</html>'));

    expect(await fetchSettings(env)).toBe(false);
    expect(setting('ACCESS_PASSWORD', {})).toBe('still-good');
  });
});

describe('transcription keys', () => {
  test('a control plane cannot supply GROQ_API_KEY', () => {
    expect(parseSettings({ GROQ_API_KEY: 'gsk_x' })).toEqual({});
  });
});
