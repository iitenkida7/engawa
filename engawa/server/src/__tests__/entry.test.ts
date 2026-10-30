import { afterEach, describe, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import {
  ENTRY_TOKEN_MAX_LENGTH,
  ENTRY_TOKEN_MAX_LIFETIME_S,
  ENTRY_USER_ID_MAX_LENGTH,
  type EntryClaims,
  entryAuth,
  normalizeEntryMode,
  signEntryToken,
  verifyEntryToken,
} from '../entry';
import { applySettings, resetSettings } from '../settings';

const KEY = 'control-plane-shared-secret';
const OTHER_KEY = 'some-other-offices-secret';

// 2026-01-01T00:00:00Z, so every expiry in this file reads as a plain offset.
const NOW_MS = Date.UTC(2026, 0, 1);
const NOW_S = NOW_MS / 1000;

const claims = (over: Partial<EntryClaims> = {}): EntryClaims => ({
  userId: 'u_123',
  name: 'Ishii',
  exp: NOW_S + 12 * 60 * 60,
  ...over,
});

/** Mint a ticket whose payload is arbitrary JSON (valid claims or not). */
function tokenOf(payload: unknown, secret = KEY): string {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`;
}

describe('normalizeEntryMode', () => {
  test('only an exact "token" turns tickets on', () => {
    expect(normalizeEntryMode('token')).toBe('token');
    expect(normalizeEntryMode(' TOKEN ')).toBe('token');
  });

  test('anything else is the historical password gate', () => {
    // A typo, a stray value or a cleared setting must never lock a self-hosted
    // office behind a gate it has no tickets for.
    for (const raw of [undefined, '', '   ', 'password', 'tokens', 'true', 'yes']) {
      expect(normalizeEntryMode(raw)).toBe('password');
    }
  });
});

describe('entryAuth', () => {
  afterEach(() => resetSettings());

  test('defaults to the password gate with nothing configured', () => {
    expect(entryAuth({})).toEqual({ mode: 'password', secret: undefined });
  });

  test('reads the mode from the environment and the key from CONTROL_PLANE_TOKEN', () => {
    expect(entryAuth({ ENTRY_MODE: 'token', CONTROL_PLANE_TOKEN: KEY })).toEqual({
      mode: 'token',
      secret: KEY,
    });
  });

  test('a control plane can switch the mode without a restart', () => {
    applySettings({ ENTRY_MODE: 'token' });
    expect(entryAuth({ CONTROL_PLANE_TOKEN: KEY }).mode).toBe('token');
  });

  test('a control plane cannot supply the key it is verified with', () => {
    // ENTRY_MODE is in the settings whitelist; CONTROL_PLANE_TOKEN is not, and
    // must not become settable by the far end — a key chosen by whoever answers
    // would verify nothing.
    applySettings({ ENTRY_MODE: 'token' });
    expect(entryAuth({}).secret).toBeUndefined();
  });
});

describe('verifyEntryToken — a good ticket', () => {
  test('accepts one we just signed and returns its claims', () => {
    const verdict = verifyEntryToken(signEntryToken(claims(), KEY), KEY, NOW_MS);
    expect(verdict).toEqual({ ok: true, claims: claims() });
  });

  test('carries the name through unchanged, including non-ASCII', () => {
    const token = signEntryToken(claims({ name: '石井 たけし' }), KEY);
    const verdict = verifyEntryToken(token, KEY, NOW_MS);
    expect(verdict.ok && verdict.claims.name).toBe('石井 たけし');
  });

  test('is still good one second before it expires', () => {
    const token = signEntryToken(claims({ exp: NOW_S + 1 }), KEY);
    expect(verifyEntryToken(token, KEY, NOW_MS).ok).toBe(true);
  });
});

describe('verifyEntryToken — no ticket', () => {
  test('a missing or empty ticket is rejected, not waved through', () => {
    for (const raw of [undefined, null, '', 0, {}, []]) {
      expect(verifyEntryToken(raw, KEY, NOW_MS)).toEqual({ ok: false, reason: 'missing' });
    }
  });

  test('without a key nothing is accepted', () => {
    // A misconfigured office refuses everyone rather than letting everyone in.
    const token = signEntryToken(claims(), KEY);
    expect(verifyEntryToken(token, undefined, NOW_MS)).toEqual({ ok: false, reason: 'no-key' });
    expect(verifyEntryToken(token, '', NOW_MS)).toEqual({ ok: false, reason: 'no-key' });
  });
});

describe('verifyEntryToken — tampering', () => {
  test('rejects a ticket whose claims were edited', () => {
    const token = signEntryToken(claims(), KEY);
    const [, signature] = token.split('.');
    // Re-encode a different name against the original signature.
    const forged = Buffer.from(JSON.stringify(claims({ name: 'Someone Else' })), 'utf8').toString(
      'base64url',
    );
    expect(verifyEntryToken(`${forged}.${signature}`, KEY, NOW_MS)).toEqual({
      ok: false,
      reason: 'bad-signature',
    });
  });

  test('rejects a ticket whose expiry was pushed out', () => {
    const token = signEntryToken(claims({ exp: NOW_S - 1 }), KEY);
    const [, signature] = token.split('.');
    const forged = Buffer.from(JSON.stringify(claims({ exp: NOW_S + 60 })), 'utf8').toString(
      'base64url',
    );
    expect(verifyEntryToken(`${forged}.${signature}`, KEY, NOW_MS)).toEqual({
      ok: false,
      reason: 'bad-signature',
    });
  });

  test('rejects a flipped character in the signature', () => {
    const token = signEntryToken(claims(), KEY);
    const flipped = token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A');
    expect(verifyEntryToken(flipped, KEY, NOW_MS)).toEqual({
      ok: false,
      reason: 'bad-signature',
    });
  });

  test('a signature of the wrong length is answered, not thrown at', () => {
    // timingSafeEqual throws on a length mismatch; a truncated or padded
    // signature must come back as an ordinary rejection.
    const [payload, signature] = signEntryToken(claims(), KEY).split('.');
    for (const sig of [signature.slice(0, 8), `${signature}AAAA`, 'A']) {
      expect(verifyEntryToken(`${payload}.${sig}`, KEY, NOW_MS)).toEqual({
        ok: false,
        reason: 'bad-signature',
      });
    }
  });
});

describe('verifyEntryToken — another office’s key', () => {
  test('rejects a well-formed ticket signed with a different secret', () => {
    const token = signEntryToken(claims(), OTHER_KEY);
    expect(verifyEntryToken(token, KEY, NOW_MS)).toEqual({
      ok: false,
      reason: 'bad-signature',
    });
  });

  test('the same claims under two keys produce different tickets', () => {
    expect(signEntryToken(claims(), KEY)).not.toBe(signEntryToken(claims(), OTHER_KEY));
  });
});

describe('verifyEntryToken — expiry', () => {
  test('rejects a ticket that has run out', () => {
    const token = signEntryToken(claims({ exp: NOW_S - 1 }), KEY);
    expect(verifyEntryToken(token, KEY, NOW_MS)).toEqual({ ok: false, reason: 'expired' });
  });

  test('rejects one that expires exactly now', () => {
    const token = signEntryToken(claims({ exp: NOW_S }), KEY);
    expect(verifyEntryToken(token, KEY, NOW_MS)).toEqual({ ok: false, reason: 'expired' });
  });

  test('refuses a lifetime longer than we are willing to honour', () => {
    // A ticket cannot be revoked before it expires, so an unbounded one is not
    // a ticket. This also catches an `exp` accidentally signed in milliseconds.
    const token = signEntryToken(claims({ exp: NOW_S + ENTRY_TOKEN_MAX_LIFETIME_S + 60 }), KEY);
    expect(verifyEntryToken(token, KEY, NOW_MS)).toEqual({ ok: false, reason: 'too-long' });
    expect(verifyEntryToken(signEntryToken(claims({ exp: NOW_MS }), KEY), KEY, NOW_MS)).toEqual({
      ok: false,
      reason: 'too-long',
    });
  });

  test('accepts one right at the limit', () => {
    const token = signEntryToken(claims({ exp: NOW_S + ENTRY_TOKEN_MAX_LIFETIME_S }), KEY);
    expect(verifyEntryToken(token, KEY, NOW_MS).ok).toBe(true);
  });
});

describe('verifyEntryToken — shapes that are not tickets', () => {
  test('rejects anything that is not <payload>.<signature>', () => {
    for (const raw of ['nodot', '.sig', 'payload.', 'a.b.c', '..']) {
      expect(verifyEntryToken(raw, KEY, NOW_MS).ok).toBe(false);
    }
  });

  test('rejects an oversized ticket before doing any work on it', () => {
    const huge = `${'a'.repeat(ENTRY_TOKEN_MAX_LENGTH)}.${'b'.repeat(64)}`;
    expect(verifyEntryToken(huge, KEY, NOW_MS)).toEqual({ ok: false, reason: 'malformed' });
  });

  test('rejects a correctly signed payload that is not an object', () => {
    for (const payload of [null, 42, 'hello', ['u_1', 'Ishii']]) {
      expect(verifyEntryToken(tokenOf(payload), KEY, NOW_MS)).toEqual({
        ok: false,
        reason: 'malformed',
      });
    }
  });

  test('rejects a correctly signed ticket with unusable claims', () => {
    const bad: unknown[] = [
      { name: 'Ishii', exp: NOW_S + 60 }, // no userId: a ticket names a person
      { userId: '', name: 'Ishii', exp: NOW_S + 60 },
      { userId: 'u_1', exp: NOW_S + 60 }, // no name: nothing to show
      { userId: 'u_1', name: '', exp: NOW_S + 60 },
      { userId: 'u_1', name: 'Ishii' }, // no expiry: would never run out
      { userId: 'u_1', name: 'Ishii', exp: 'soon' },
      { userId: 'u_1', name: 'Ishii', exp: Number.NaN },
      { userId: 'u_1', name: 42, exp: NOW_S + 60 },
      { userId: 'u'.repeat(ENTRY_USER_ID_MAX_LENGTH + 1), name: 'Ishii', exp: NOW_S + 60 },
    ];
    for (const payload of bad) {
      expect(verifyEntryToken(tokenOf(payload), KEY, NOW_MS)).toEqual({
        ok: false,
        reason: 'malformed',
      });
    }
  });

  test('a payload that is not base64url JSON is malformed, not a crash', () => {
    const payload = 'not-base64url-json';
    const signature = createHmac('sha256', KEY).update(payload).digest('base64url');
    expect(verifyEntryToken(`${payload}.${signature}`, KEY, NOW_MS)).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });
});
