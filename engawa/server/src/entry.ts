import { createHmac, timingSafeEqual } from 'node:crypto';
import { setting } from './settings';

// Entry tickets: letting a control plane decide who may enter the office.
//
// A self-hosted engawa gates entry with ACCESS_PASSWORD — one shared phrase,
// and whoever knows the URL and the phrase is in. That is the whole story for a
// team running its own office, and it does not change.
//
// When engawa is run FOR someone else, the accounts live in the control plane,
// not here. Rather than teach the office about users, sessions and sign-in, we
// let it accept a ticket the control plane signed: the browser arrives at
// `/?t=<ticket>`, the office checks the signature with the key it already
// shares with the control plane (CONTROL_PLANE_TOKEN) and lets that person in
// under the name the ticket carries.
//
// Two properties are worth being explicit about:
//
//  - **No call-out.** Verification is local arithmetic. The office never asks
//    the control plane whether a ticket is good, so the control plane being
//    down does not stop anyone from entering an office that is already running.
//    The price is that a ticket cannot be revoked before it expires, which is
//    why the lifetime is capped (ENTRY_TOKEN_MAX_LIFETIME_S).
//
//  - **The name is the control plane's, not the browser's.** In this mode the
//    `name` on the join message is ignored and the ticket's name is used. It
//    cannot be spoofed, which is what makes a transcript or a recording a
//    record of who was actually there.
//
// Both sides already hold one secret (CONTROL_PLANE_TOKEN), so an HMAC is
// enough (signed with a key derived from it — see entryTicketKey) — there is no third party to convince, and nothing here needs a key
// pair. Same scheme as the settings response and the event webhook: one idea,
// used everywhere, rather than three things to learn.
//
// See docs/entry-token.md.

/** How entry is gated. `password` is the historical (and default) behaviour. */
export type EntryMode = 'password' | 'token';

export const ENTRY_MODES = ['password', 'token'] as const;

/** What a ticket says. Kept to the minimum the office actually needs. */
export type EntryClaims = {
  // The control plane's id for this person. engawa does not keep it — the
  // connection has its own per-connection id — but a ticket must name a
  // person, so that a ticket is always about someone rather than a bearer pass.
  userId: string;
  // Display name, used as-is (after the usual normalization) instead of
  // whatever the client says it is called.
  name: string;
  // Expiry, UNIX seconds.
  exp: number;
};

/** Why a ticket was not accepted. Never sent to the browser in detail. */
export type EntryRejection =
  | 'missing' // no ticket presented
  | 'no-key' // this office has no key to verify with (misconfiguration)
  | 'malformed' // not <payload>.<signature>, or the claims are not usable
  | 'bad-signature' // tampered with, or signed with another key
  | 'expired'
  | 'too-long'; // valid, but claims a lifetime we refuse to honour

export type EntryVerdict =
  | { ok: true; claims: EntryClaims }
  | { ok: false; reason: EntryRejection };

/** The key, mode and verification the office uses for entry. */
export type EntryAuth = { mode: EntryMode; secret: string | undefined };

/**
 * Longest ticket we will even look at. Claims are three small fields; anything
 * larger is not a ticket, and bounding it keeps a flood of junk cheap.
 */
export const ENTRY_TOKEN_MAX_LENGTH = 2048;

/** Cap on a claimed userId, for the same reason. */
export const ENTRY_USER_ID_MAX_LENGTH = 128;

/**
 * Longest future expiry we honour, in seconds. A ticket cannot be revoked
 * before it expires (verification is local, by design), so its lifetime is the
 * blast radius of a leaked link — and a ticket good forever is not a ticket.
 * Also catches the easy mistake of signing `exp` in milliseconds.
 */
export const ENTRY_TOKEN_MAX_LIFETIME_S = 24 * 60 * 60;

/**
 * Read the entry mode. Anything that is not exactly `token` means the
 * historical password gate, so a typo or a stray value from a control plane
 * can never silently turn a self-hosted office into one nobody can enter.
 */
export function normalizeEntryMode(raw: string | undefined): EntryMode {
  return raw?.trim().toLowerCase() === 'token' ? 'token' : 'password';
}

/**
 * The office's current entry configuration. The mode may come from a control
 * plane (it is in the settings whitelist); the key never does — it is the
 * shared secret itself, and letting the far end supply the key it is checked
 * with would check nothing.
 */
export function entryAuth(env = process.env): EntryAuth {
  return {
    mode: normalizeEntryMode(setting('ENTRY_MODE', env)),
    secret: env.CONTROL_PLANE_TOKEN,
  };
}

function base64urlText(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

/**
 * Label the ticket key is derived under. Versioned so the derivation can change
 * without a ticket signed one way ever verifying the other.
 */
export const ENTRY_TICKET_KEY_LABEL = 'engawa-entry-ticket-v1';

/**
 * The key tickets are signed with: HMAC-SHA256(CONTROL_PLANE_TOKEN, label),
 * never the token itself. The token also travels as the bearer on every
 * settings fetch, so it can end up in a control plane's access logs, a proxy or
 * an APM; deriving a separate key means a token seen there is not, on its own,
 * a way to sign tickets with any name. It also keeps a ticket signature and a
 * settings signature from ever being the same computation.
 */
export function entryTicketKey(secret: string): Buffer {
  return createHmac('sha256', secret).update(ENTRY_TICKET_KEY_LABEL).digest();
}

function signPayload(payload: string, secret: string): string {
  return createHmac('sha256', entryTicketKey(secret)).update(payload).digest('base64url');
}

/**
 * Does `actual` match `expected`? Constant-time over the signature text, and
 * `false` rather than a throw when the lengths differ (timingSafeEqual throws,
 * which would itself be a signal). Compared as text, so the bytes a ticket
 * carries are the bytes that are checked.
 */
function signaturesMatch(expected: string, actual: string): boolean {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(actual, 'utf8');
  if (a.length !== b.length) return false;

  return timingSafeEqual(a, b);
}

/**
 * Mint a ticket: `base64url(JSON claims)` + `.` + `base64url(HMAC-SHA256 of
 * that text, keyed with entryTicketKey)`. Exported so the format has one definition that tests — and any
 * control plane written in TypeScript — can use rather than reimplement.
 */
export function signEntryToken(claims: EntryClaims, secret: string): string {
  const payload = base64urlText(
    JSON.stringify({ userId: claims.userId, name: claims.name, exp: claims.exp }),
  );

  return `${payload}.${signPayload(payload, secret)}`;
}

/**
 * Read the claims out of an already-verified payload. Every field is checked:
 * the signature proves who wrote the ticket, not that they wrote it correctly.
 */
function parseClaims(payload: string): EntryClaims | null {
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;

  const { userId, name, exp } = raw as Record<string, unknown>;
  if (typeof userId !== 'string' || userId.length === 0) return null;
  if (userId.length > ENTRY_USER_ID_MAX_LENGTH) return null;
  if (typeof name !== 'string' || name.length === 0) return null;
  if (typeof exp !== 'number' || !Number.isFinite(exp)) return null;

  return { userId, name, exp };
}

/**
 * Check a ticket. Pure: the key, the clock and the ticket all come in as
 * arguments, so every outcome is testable without a server.
 *
 * The signature is checked before the payload is parsed — an unauthenticated
 * document should not get as far as JSON.parse.
 */
export function verifyEntryToken(
  raw: unknown,
  secret: string | undefined,
  nowMs: number,
): EntryVerdict {
  if (typeof raw !== 'string' || raw.length === 0) return { ok: false, reason: 'missing' };
  if (!secret) return { ok: false, reason: 'no-key' };
  if (raw.length > ENTRY_TOKEN_MAX_LENGTH) return { ok: false, reason: 'malformed' };

  const dot = raw.indexOf('.');
  if (dot <= 0 || dot === raw.length - 1) return { ok: false, reason: 'malformed' };
  const payload = raw.slice(0, dot);
  const signature = raw.slice(dot + 1);
  // One separator exactly: a second dot means this is some other format.
  if (signature.includes('.')) return { ok: false, reason: 'malformed' };

  if (!signaturesMatch(signPayload(payload, secret), signature)) {
    return { ok: false, reason: 'bad-signature' };
  }

  const claims = parseClaims(payload);
  if (!claims) return { ok: false, reason: 'malformed' };

  const nowS = nowMs / 1000;
  if (claims.exp <= nowS) return { ok: false, reason: 'expired' };
  if (claims.exp - nowS > ENTRY_TOKEN_MAX_LIFETIME_S) return { ok: false, reason: 'too-long' };

  return { ok: true, claims };
}
