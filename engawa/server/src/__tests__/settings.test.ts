import { afterEach, describe, expect, test } from 'bun:test';
import {
  applySettings,
  fetchSettings,
  normalizeIntervalSeconds,
  parseSettings,
  resetSettings,
  setting,
  settingsEnv,
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

describe('fetchSettings', () => {
  const originalFetch = globalThis.fetch;
  const env = { CONTROL_PLANE_URL: 'https://control.example/settings' };

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
      return Response.json({});
    });

    await fetchSettings(env);
    expect(seen).toBeNull();

    await fetchSettings({ ...env, CONTROL_PLANE_TOKEN: 'sekrit' });
    expect(seen).toBe('Bearer sekrit');
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
