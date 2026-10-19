// The Groq API key dialog behind the transcribe button.
//
// The key belongs to the user, not to the deployment: it is kept in this
// browser's localStorage and sent only to api.groq.com. It is never put in a
// WebSocket message, a URL, or the net log — our server has no business
// holding other people's API credentials (and inviting it to would undo the
// point of invariant #1, which keeps the audio off it in the first place).

import { t } from '@/core/i18n';
import {
  DEFAULT_GROQ_MODEL,
  GROQ_KEY_STORAGE,
  GROQ_MODEL_STORAGE,
  GROQ_MODELS,
  type GroqModel,
  parseGroqKey,
  parseGroqModel,
} from '@/media/groq';

export function loadGroqKey(): string | null {
  try {
    return parseGroqKey(localStorage.getItem(GROQ_KEY_STORAGE));
  } catch {
    return null; // private-mode storage
  }
}

export function loadGroqModel(): GroqModel {
  try {
    return parseGroqModel(localStorage.getItem(GROQ_MODEL_STORAGE));
  } catch {
    return DEFAULT_GROQ_MODEL;
  }
}

function persist(key: string | null, model: GroqModel) {
  try {
    if (key) localStorage.setItem(GROQ_KEY_STORAGE, key);
    else localStorage.removeItem(GROQ_KEY_STORAGE);
    localStorage.setItem(GROQ_MODEL_STORAGE, model);
  } catch {
    /* ignore private-mode storage errors */
  }
}

export class TranscriptSetup {
  private root: HTMLElement;
  private input: HTMLInputElement;
  private select: HTMLSelectElement;
  private error: HTMLElement;
  private onConfirm: ((key: string, model: GroqModel) => void) | null = null;

  constructor() {
    this.root = document.getElementById('transcript-setup') as HTMLElement;
    this.input = document.getElementById('transcript-key') as HTMLInputElement;
    this.select = document.getElementById('transcript-model') as HTMLSelectElement;
    this.error = document.getElementById('transcript-setup-error') as HTMLElement;

    for (const model of GROQ_MODELS) {
      const opt = document.createElement('option');
      opt.value = model;
      opt.textContent = `${model} — ${t(model === DEFAULT_GROQ_MODEL ? 'transcript.modelTurbo' : 'transcript.modelLarge')}`;
      this.select.appendChild(opt);
    }

    document.getElementById('transcript-cancel')?.addEventListener('click', () => this.close());
    document.getElementById('transcript-confirm')?.addEventListener('click', () => this.confirm());
    document.getElementById('transcript-forget')?.addEventListener('click', () => {
      persist(null, parseGroqModel(this.select.value));
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

  open(onConfirm: (key: string, model: GroqModel) => void) {
    this.onConfirm = onConfirm;
    this.input.value = loadGroqKey() ?? '';
    this.select.value = loadGroqModel();
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
    const model = parseGroqModel(this.select.value);
    persist(key, model);
    const done = this.onConfirm;
    this.close();
    done?.(key, model);
  }
}
