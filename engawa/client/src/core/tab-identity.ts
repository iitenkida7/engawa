import { t } from '@/core/i18n';

// Duplicate-tab handling: one browser is one avatar, and the newest tab wins.
// `engawa-client-id` identifies the browser (sent on join; the server replaces
// an older joined connection carrying the same id). `engawa-active-tab` records
// the tab that joined most recently, so an older tab whose socket was already
// dead when it got replaced still knows not to rejoin (it never received the
// server's `replaced-by-new-tab`).

export const CLIENT_ID_KEY = 'engawa-client-id';
export const ACTIVE_TAB_KEY = 'engawa-active-tab';

type KeyValue = Pick<Storage, 'getItem' | 'setItem'>;

// localStorage can throw (blocked site data, some private modes); treat that as
// "no storage" rather than breaking the join.
function defaultStorage(): KeyValue | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** The browser's persistent id, minted and saved on first use. */
export function loadClientId(
  storage: KeyValue | null = defaultStorage(),
  mint: () => string = () => crypto.randomUUID(),
): string {
  try {
    const stored = storage?.getItem(CLIENT_ID_KEY);
    if (stored && /^[A-Za-z0-9-]{1,64}$/.test(stored)) return stored;
  } catch {
    /* fall through to a fresh id */
  }
  const id = mint();
  try {
    storage?.setItem(CLIENT_ID_KEY, id);
  } catch {
    /* id lives for this page only */
  }
  return id;
}

/** Record `tabId` as the browser's most recently joined tab. */
export function markActiveTab(tabId: string, storage: KeyValue | null = defaultStorage()) {
  try {
    storage?.setItem(ACTIVE_TAB_KEY, tabId);
  } catch {
    /* best effort */
  }
}

/** True when another tab of this browser has joined since `tabId` did. */
export function isSupersededTab(
  tabId: string,
  storage: KeyValue | null = defaultStorage(),
): boolean {
  try {
    const active = storage?.getItem(ACTIVE_TAB_KEY);
    return !!active && active !== tabId;
  } catch {
    return false;
  }
}

/** Full-screen notice for a tab replaced by a newer one, with a way back in. */
export function showReplacedOverlay(
  doc: Document = document,
  reload: () => void = () => window.location.reload(),
) {
  if (doc.getElementById('replaced-overlay')) return;
  const overlay = doc.createElement('div');
  overlay.id = 'replaced-overlay';
  const card = doc.createElement('div');
  card.className = 'replaced-card';
  const msg = doc.createElement('p');
  msg.textContent = t('app.replacedByNewTab');
  const btn = doc.createElement('button');
  btn.type = 'button';
  btn.textContent = t('app.rejoinHere');
  btn.addEventListener('click', () => reload());
  card.append(msg, btn);
  overlay.appendChild(card);
  doc.body.appendChild(overlay);
}
