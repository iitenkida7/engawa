// The Groq API key dialog behind the transcribe button.
//
// The key belongs to the user, not to the deployment: it is kept in this
// browser's localStorage and sent only to api.groq.com. It is never put in a
// WebSocket message, a URL, or the net log — our server has no business
// holding other people's API credentials (and inviting it to would undo the
// point of invariant #1, which keeps the audio off it in the first place).

import { t } from '@/core/i18n';
import { GROQ_KEY_STORAGE, parseGroqKey } from '@/media/groq';

export function loadGroqKey(): string | null {
  try {
    return parseGroqKey(localStorage.getItem(GROQ_KEY_STORAGE));
  } catch {
    return null; // private-mode storage
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
  private onConfirm: ((key: string) => void) | null = null;

  constructor() {
    this.root = document.getElementById('transcript-setup') as HTMLElement;
    this.input = document.getElementById('transcript-key') as HTMLInputElement;
    this.error = document.getElementById('transcript-setup-error') as HTMLElement;
    this.confirmBtn = document.getElementById('transcript-confirm') as HTMLButtonElement;

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
    this.input.value = loadGroqKey() ?? '';
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
