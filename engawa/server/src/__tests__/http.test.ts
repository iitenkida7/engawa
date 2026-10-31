import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHttpHandler, type HttpDeps, MEDIA_TOKEN_HEADER } from '../http';
import { applySettings, resetSettings } from '../settings';
import type { SfuProxyResult } from '../sfu';

// A stand-in for ./public: the built client the server falls through to.
const PUBLIC_DIR = mkdtempSync(join(tmpdir(), 'engawa-public-'));
writeFileSync(join(PUBLIC_DIR, 'index.html'), '<!doctype html>the built client');
writeFileSync(join(PUBLIC_DIR, 'app.js'), 'console.log("bundle")');
// An image that was never built — nothing is served from here.
const EMPTY_DIR = mkdtempSync(join(tmpdir(), 'engawa-empty-'));

afterAll(() => {
  rmSync(PUBLIC_DIR, { recursive: true, force: true });
  rmSync(EMPTY_DIR, { recursive: true, force: true });
});

// The token a joined client presents; anything else is an anonymous caller.
const TOKEN = 'media-token-from-welcome';
const MAP_JSON = '{"version":1,"cols":10,"rows":10}';

const ICE = [{ urls: 'stun:stun.example:19302' }];

function handler(over: Partial<HttpDeps> = {}) {
  return createHttpHandler({
    clients: new Map(),
    mediaTokens: new Set([TOKEN]),
    mapJson: MAP_JSON,
    publicDir: PUBLIC_DIR,
    getTurnCredentials: async () => ICE,
    isSfuEnabled: () => true,
    proxySfuRequest: async () => ({ status: 201, body: { sessionId: 's1' } }),
    ...over,
  });
}

function req(path: string, init: RequestInit = {}) {
  return new Request(`http://office.example${path}`, init);
}

// A request carrying the token a client got from `welcome`.
function joined(path: string, init: RequestInit = {}) {
  return req(path, {
    ...init,
    headers: { ...(init.headers as Record<string, string>), [MEDIA_TOKEN_HEADER]: TOKEN },
  });
}

afterEach(() => {
  resetSettings();
});

describe('media-token gate (billable Cloudflare endpoints)', () => {
  test('an anonymous caller gets 401 from /api/turn-credentials', async () => {
    const res = await handler()(req('/api/turn-credentials'));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      errorCode: 'unauthorized',
      errorDescription: 'join required',
    });
  });

  test('a token that was never minted is rejected', async () => {
    const res = await handler()(
      req('/api/turn-credentials', { headers: { [MEDIA_TOKEN_HEADER]: 'guessed' } }),
    );
    expect(res.status).toBe(401);
  });

  test('a joined client gets the credentials', async () => {
    const res = await handler()(joined('/api/turn-credentials'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(ICE);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  test('the SFU proxy is behind the same gate', async () => {
    const res = await handler()(req('/api/sfu/sessions/new', { method: 'POST' }));
    expect(res.status).toBe(401);
  });

  test('every rejection carries its own readable body', async () => {
    // Regression: a module-level Response instance can only be read once, so
    // the second caller used to get a 500 instead of the 401.
    const handle = handler();
    const first = await handle(req('/api/turn-credentials'));
    const second = await handle(req('/api/turn-credentials'));
    expect(await first.json()).toEqual(await second.json());
    expect(second.status).toBe(401);
  });

  test('the gate runs before the SFU-disabled answer, so configuration stays private', async () => {
    const res = await handler({ isSfuEnabled: () => false })(
      req('/api/sfu/sessions/new', { method: 'POST' }),
    );
    expect(res.status).toBe(401);
  });

  test('a credential request is never made for an anonymous caller', async () => {
    let calls = 0;
    const res = await handler({
      getTurnCredentials: async () => {
        calls += 1;
        return ICE;
      },
    })(req('/api/turn-credentials'));
    expect(res.status).toBe(401);
    expect(calls).toBe(0);
  });
});

describe('/api/health', () => {
  test('reports the live connection count without a token', async () => {
    const clients = new Map([
      ['a', {}],
      ['b', {}],
    ]);
    const res = await handler({ clients })(req('/api/health'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, clients: 2 });
  });
});

describe('/api/map', () => {
  test('serves the map validated at boot, uncached', async () => {
    const res = await handler()(req('/api/map'));
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/json');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(await res.text()).toBe(MAP_JSON);
  });
});

describe('/api/config (which gate the join screen shows)', () => {
  test('password mode with a password set asks for one', async () => {
    applySettings({ ENTRY_MODE: 'password', ACCESS_PASSWORD: 'open-sesame' });
    const res = await handler()(req('/api/config'));
    expect(await res.json()).toEqual({ entryMode: 'password', passwordRequired: true });
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  test('an open office asks for nothing', async () => {
    applySettings({ ENTRY_MODE: 'password', ACCESS_PASSWORD: null });
    const res = await handler()(req('/api/config'));
    expect(await res.json()).toEqual({ entryMode: 'password', passwordRequired: false });
  });

  test('ticket mode never reports a leftover password (the gates are exclusive)', async () => {
    applySettings({ ENTRY_MODE: 'token', ACCESS_PASSWORD: 'still-in-the-env' });
    const res = await handler()(req('/api/config'));
    expect(await res.json()).toEqual({ entryMode: 'token', passwordRequired: false });
  });
});

describe('/api/verify-password (pre-join UX helper)', () => {
  const post = (body: unknown) =>
    req('/api/verify-password', { method: 'POST', body: JSON.stringify(body) });

  test('only POST is allowed', async () => {
    const res = await handler()(req('/api/verify-password'));
    expect(res.status).toBe(405);
  });

  test('accepts the right password and refuses a wrong one', async () => {
    applySettings({ ACCESS_PASSWORD: 'open-sesame' });
    const ok = await handler()(post({ password: 'open-sesame' }));
    expect(await ok.json()).toEqual({ ok: true });
    const no = await handler()(post({ password: 'guess' }));
    expect(await no.json()).toEqual({ ok: false });
  });

  test('a malformed body is an answer, not a crash', async () => {
    applySettings({ ACCESS_PASSWORD: 'open-sesame' });
    const res = await handler()(
      req('/api/verify-password', { method: 'POST', body: 'not json at all' }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false });
  });

  test('a non-string password is refused rather than coerced', async () => {
    applySettings({ ACCESS_PASSWORD: 'open-sesame' });
    const res = await handler()(post({ password: { toString: 'open-sesame' } }));
    expect(await res.json()).toEqual({ ok: false });
  });

  test('an open office lets anyone through', async () => {
    applySettings({ ACCESS_PASSWORD: null });
    const res = await handler()(post({}));
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe('/api/sfu/* proxy', () => {
  test('forwards an allowed path and returns the upstream answer verbatim', async () => {
    const seen: Array<[string, string, unknown]> = [];
    const proxySfuRequest = async (
      method: string,
      path: string,
      body: unknown,
    ): Promise<SfuProxyResult> => {
      seen.push([method, path, body]);
      return { status: 201, body: { sessionDescription: 'answer' } };
    };
    const res = await handler({ proxySfuRequest })(
      joined('/api/sfu/sessions/abc123/tracks/new', {
        method: 'POST',
        body: JSON.stringify({ tracks: [] }),
      }),
    );
    expect(seen).toEqual([['POST', '/abc123/tracks/new', { tracks: [] }]]);
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ sessionDescription: 'answer' });
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  test('an upstream failure status is passed through, not flattened', async () => {
    const res = await handler({
      proxySfuRequest: async () => ({ status: 429, body: { errorCode: 'rate_limited' } }),
    })(joined('/api/sfu/sessions/new', { method: 'POST', body: '{}' }));
    expect(res.status).toBe(429);
  });

  test('answers 503 when no SFU is configured', async () => {
    const res = await handler({ isSfuEnabled: () => false })(
      joined('/api/sfu/sessions/new', { method: 'POST', body: '{}' }),
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      errorCode: 'sfu_disabled',
      errorDescription: 'SFU disabled',
    });
  });

  test('a path outside the whitelist is 404 and never forwarded (SSRF guard)', async () => {
    let forwarded = 0;
    const handle = handler({
      proxySfuRequest: async () => {
        forwarded += 1;
        return { status: 200, body: {} };
      },
    });
    for (const path of [
      '/api/sfu/sessions/abc123/keys',
      '/api/sfu/sessions/abc123/tracks/delete',
      '/api/sfu/sessions',
    ]) {
      const res = await handle(joined(path, { method: 'POST', body: '{}' }));
      expect(res.status).toBe(404);
    }
    expect(forwarded).toBe(0);
  });

  test('only POST and PUT reach the control plane', async () => {
    const handle = handler();
    for (const method of ['GET', 'DELETE', 'PATCH']) {
      const res = await handle(joined('/api/sfu/sessions/new', { method }));
      expect(res.status).toBe(405);
    }
  });

  test('a malformed body is forwarded as undefined rather than throwing', async () => {
    let seenBody: unknown = 'untouched';
    const res = await handler({
      proxySfuRequest: async (_m, _p, body) => {
        seenBody = body;
        return { status: 200, body: {} };
      },
    })(joined('/api/sfu/sessions/new', { method: 'POST', body: 'not json' }));
    expect(res.status).toBe(200);
    expect(seenBody).toBeUndefined();
  });
});

describe('static files and the SPA fallback', () => {
  test('serves a built asset', async () => {
    const res = await handler()(req('/app.js'));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('console.log("bundle")');
  });

  test('/ serves index.html', async () => {
    const res = await handler()(req('/'));
    expect(await res.text()).toContain('the built client');
  });

  test('an unknown extensionless path falls back to the client (client-side routing)', async () => {
    const res = await handler()(req('/some/deep/route'));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('the built client');
  });

  test('a missing asset is 404 — the fallback never answers with HTML', async () => {
    const res = await handler()(req('/assets/missing.js'));
    expect(res.status).toBe(404);
  });

  test('without a built client everything is 404', async () => {
    const res = await handler({ publicDir: EMPTY_DIR })(req('/some/deep/route'));
    expect(res.status).toBe(404);
  });
});
