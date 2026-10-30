// Entry tickets, browser side (see docs/entry-token.md).
//
// When the office runs in entry-token mode, people arrive from a control plane
// at `/?t=<ticket>` instead of typing a shared passphrase. Two small jobs here:
//
//  - Take the ticket out of the address bar as soon as it has been read. A
//    query string is the most quoted, screenshotted and Referer-leaked part of
//    a URL, and the ticket is a credential for the next several hours.
//  - Keep it for the rest of its life, so a reload or a laptop lid does not
//    send the person back to the control plane to be let in again.
//
// The ticket is never decoded here: what it says is the server's business, and
// a browser that believed its own reading of it would be inventing a second,
// unverified source of truth about who you are.

export const ENTRY_TOKEN_KEY = 'engawa-entry-token';

/** Query parameter the control plane links with: `https://office/?t=…`. */
export const ENTRY_TOKEN_PARAM = 't';

/** Mirror of the server's cap (entry.ts) so nothing oversized is kept or sent. */
export const ENTRY_TOKEN_MAX_LENGTH = 2048;

// <payload>.<signature>, both base64url. Anything else cannot verify, so it is
// not worth storing or putting on the wire.
const TOKEN_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

type KeyValue = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

// localStorage can throw (blocked site data, some private modes); treat that as
// "no storage" rather than breaking the join.
function defaultStorage(): KeyValue | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * A ticket we are willing to use, or null. Shape only — whether it verifies is
 * for the server to say.
 */
export function sanitizeEntryToken(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const token = raw.trim();
  if (token.length === 0 || token.length > ENTRY_TOKEN_MAX_LENGTH) return null;

  return TOKEN_SHAPE.test(token) ? token : null;
}

/**
 * Which ticket to enter with: the one in the link wins, so following a fresh
 * link always replaces a stale saved ticket rather than being ignored by it.
 * Pure, so the precedence is testable on its own.
 */
export function pickEntryToken(fromUrl: string | null, stored: string | null): string | null {
  return sanitizeEntryToken(fromUrl) ?? sanitizeEntryToken(stored);
}

export function loadEntryToken(storage: KeyValue | null = defaultStorage()): string | null {
  try {
    return sanitizeEntryToken(storage?.getItem(ENTRY_TOKEN_KEY) ?? null);
  } catch {
    return null;
  }
}

export function storeEntryToken(token: string, storage: KeyValue | null = defaultStorage()) {
  try {
    storage?.setItem(ENTRY_TOKEN_KEY, token);
  } catch {
    /* the ticket lives for this page only */
  }
}

export function clearEntryToken(storage: KeyValue | null = defaultStorage()) {
  try {
    storage?.removeItem(ENTRY_TOKEN_KEY);
  } catch {
    /* best effort */
  }
}

/**
 * The URL to show once the ticket has been read out of it, or null when there
 * was nothing to strip. Pure (takes and returns a URL string) so the rewriting
 * is tested without a History API.
 */
export function urlWithoutEntryToken(href: string): string | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (!url.searchParams.has(ENTRY_TOKEN_PARAM)) return null;
  url.searchParams.delete(ENTRY_TOKEN_PARAM);

  return url.toString();
}
