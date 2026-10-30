// The Groq API key dialog behind the transcribe button.
//
// There are two ways a key gets here, and the difference matters.
//
// Normally the key belongs to the user: it is kept in this browser's
// localStorage and sent only to api.groq.com. It is never put in a WebSocket
// message, a URL, or the net log — our server has no business holding other
// people's API credentials (and inviting it to would undo the point of
// invariant #1, which keeps the audio off it in the first place).
//
// A deployment may instead provide one key for everyone in the space
// (GROQ_API_KEY, or a control plane — see docs/control-plane.md). That key
// belongs to whoever runs the space and has chosen to share it with the people
// in it, so the same objection does not apply: it is their key, their bill, and
// their decision. It is served only to a joined session (the endpoint requires
// the media token) and is never written to localStorage or rendered into the
// dialog.

import { t } from '@/core/i18n';
import { mediaAuthHeaders } from '@/core/media-auth';
import { GROQ_KEY_STORAGE, parseGroqKey } from '@/media/groq';

// Set once per join, when the deployment provides a key for everybody.
let providedKey: string | null = null;

export function setProvidedGroqKey(key: string | null): void {
  providedKey = parseGroqKey(key);
}

export function hasProvidedGroqKey(): boolean {
  return providedKey !== null;
}

/** The user's own key, if they have stored one. */
export function loadStoredGroqKey(): string | null {
  try {
    return parseGroqKey(localStorage.getItem(GROQ_KEY_STORAGE));
  } catch {
    return null; // private-mode storage
  }
}

/**
 * The key to transcribe with. A key the deployment provides wins, so members of
 * a hosted space don't each need a Groq account; otherwise it's the user's own.
 */
export function loadGroqKey(): string | null {
  return providedKey ?? loadStoredGroqKey();
}

/**
 * Ask the server whether this deployment provides a key. Called once after
 * joining — the endpoint requires the media token, which only a joined session
 * has. A failure just leaves us on the user's own key.
 */
export async function fetchProvidedGroqKey(): Promise<void> {
  try {
    const res = await fetch('/api/transcription-credentials', { headers: mediaAuthHeaders() });
    if (!res.ok) return;
    const data = (await res.json()) as { apiKey?: unknown };
    setProvidedGroqKey(typeof data.apiKey === 'string' ? data.apiKey : null);
  } catch {
    // Offline or an older server: the personal key still works.
  }
}

function persist(key: string | null) {
  try {
    if (key) localStorage.setItem(GROQ_KEY_STORAGE, key);
    else localStorage.removeItem(GROQ_KEY_STORAGE);
  } catch {
    /* ignore private-mode storage errors */
  }
}

export class TranscriptSetup {
  private root: HTMLElement;
  private input: HTMLInputElement;
  private error: HTMLElement;
  private confirmBtn: HTMLButtonElement;
  private provided: HTMLElement | null;
  private onConfirm: ((key: string) => void) | null = null;

  constructor() {
    this.root = document.getElementById('transcript-setup') as HTMLElement;
    this.input = document.getElementById('transcript-key') as HTMLInputElement;
    this.error = document.getElementById('transcript-setup-error') as HTMLElement;
    this.confirmBtn = document.getElementById('transcript-confirm') as HTMLButtonElement;
    this.provided = document.getElementById('transcript-setup-provided');

    document.getElementById('transcript-cancel')?.addEventListener('click', () => this.close());
    this.confirmBtn.addEventListener('click', () => this.confirm());
    document.getElementById('transcript-forget')?.addEventListener('click', () => {
      persist(null);
      this.input.value = '';
      this.close();
    });
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.confirm();
    });
    // Click the backdrop (not the card) to dismiss, like a normal modal.
    this.root.addEventListener('click', (e) => {
      if (e.target === this.root) this.close();
    });
  }

  // `onConfirm` is given when the dialog stands between the user and starting a
  // transcription; opened from the menu to edit a stored key it is omitted, and
  // the button just saves.
  open(onConfirm?: (key: string) => void) {
    this.onConfirm = onConfirm ?? null;
    this.confirmBtn.textContent = t(onConfirm ? 'transcript.setupStart' : 'transcript.setupSave');
    // The deployment's key is never rendered here — it isn't the user's to see,
    // and putting it in the DOM would be the one place it could leak from.
    this.input.value = loadStoredGroqKey() ?? '';
    this.provided?.classList.toggle('hidden', !hasProvidedGroqKey());
    this.error.textContent = '';
    this.root.classList.remove('hidden');
    this.input.focus();
  }

  close() {
    this.root.classList.add('hidden');
    this.onConfirm = null;
  }

  private confirm() {
    const key = parseGroqKey(this.input.value);
    if (!key) {
      this.error.textContent = t('transcript.invalidKey');
      return;
    }
    persist(key);
    const done = this.onConfirm;
    this.close();
    done?.(key);
  }
}
