import { App } from '@/core/app';
import { applyI18n, getLang, type Lang, setLang } from '@/core/i18n';
import { AvatarEditor } from '@/ui/avatar-editor';

const joinOverlay = document.getElementById('join-overlay') as HTMLDivElement;
const passForm = document.getElementById('join-pass-form') as HTMLFormElement;
const passInput = document.getElementById('join-password') as HTMLInputElement;
const passError = document.getElementById('join-pass-error') as HTMLDivElement;
const passRemember = document.getElementById('join-pass-remember') as HTMLInputElement;
const nameForm = document.getElementById('join-form') as HTMLFormElement;
const nameInput = document.getElementById('join-name') as HTMLInputElement;
const btnAvatarPre = document.getElementById('btn-avatar-pre') as HTMLButtonElement;
const canvas = document.getElementById('canvas') as HTMLCanvasElement;

// Translate the static markup (data-i18n attributes) before the join overlay is
// shown, then wire the language toggle (issue #172). setLang persists + reloads.
applyI18n();
{
  const activeLang = getLang();
  for (const btn of document.querySelectorAll<HTMLButtonElement>('[data-lang-set]')) {
    const lang = btn.dataset.langSet as Lang;
    btn.classList.toggle('active', lang === activeLang);
    btn.addEventListener('click', () => setLang(lang));
  }
}

const stored = localStorage.getItem('engawa-name');
if (stored) nameInput.value = stored;

// One editor instance, shared between the join screen (pre-join) and the App's
// in-room 🧍 button. App reads the persisted outfit on join (see app.ts).
const editor = new AvatarEditor();
btnAvatarPre.addEventListener('click', () => editor.open());

let app: App | null = null;
// Password verified at the gate; sent on join. '' when the space is open.
let verifiedPassword = '';

// Remembered passphrase (opt-in, localStorage). Stored only after a successful
// verify when "remember on this device" is checked, so returning users skip the
// gate. Cleared whenever it stops working (wrong/changed → auth error).
const PASS_KEY = 'engawa-pass';
const getStoredPass = () => localStorage.getItem(PASS_KEY) ?? '';
const clearStoredPass = () => localStorage.removeItem(PASS_KEY);

// POST the passphrase to the server; true when it's accepted.
async function verifyPassword(password: string): Promise<boolean> {
  try {
    const res = await fetch('/api/verify-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    return !!((await res.json()) as { ok?: boolean }).ok;
  } catch {
    return false;
  }
}

function showNameStep() {
  passForm.classList.add('hidden');
  nameForm.classList.remove('hidden');
  nameInput.focus();
}

function showPassStep() {
  nameForm.classList.add('hidden');
  passForm.classList.remove('hidden');
  passError.classList.add('hidden');
  passInput.focus();
}

// On load, ask the server whether a password is required. Only then show the
// password gate before the name step; otherwise go straight to the name step
// (an open space never asks for a password).
async function initLogin() {
  let passwordRequired = false;
  try {
    const res = await fetch('/api/config');
    passwordRequired = !!((await res.json()) as { passwordRequired?: boolean }).passwordRequired;
  } catch {
    passwordRequired = false;
  }
  if (!passwordRequired) {
    showNameStep();
    return;
  }
  // Skip the gate when a remembered passphrase still verifies; otherwise show it
  // (clearing a stale saved one).
  const saved = getStoredPass();
  if (saved && (await verifyPassword(saved))) {
    verifiedPassword = saved;
    showNameStep();
    return;
  }
  if (saved) clearStoredPass();
  showPassStep();
}

passForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const password = passInput.value;
  passError.classList.add('hidden');
  if (!(await verifyPassword(password))) {
    passError.classList.remove('hidden');
    return;
  }
  verifiedPassword = password;
  // Remember on this device only when opted in; otherwise make sure nothing lingers.
  if (passRemember.checked) localStorage.setItem(PASS_KEY, password);
  else clearStoredPass();
  showNameStep();
});

nameForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const name = nameInput.value.trim();
  if (!name) return;
  localStorage.setItem('engawa-name', name);
  joinOverlay.classList.add('hidden');

  if (!app) {
    app = new App({ canvas, editor });
  }
  app.start(name, verifiedPassword);
});

// If a later join is rejected (e.g. the password changed), the App re-shows the
// overlay; the remembered passphrase is now wrong, so drop it and restart at the
// gate with the error visible (so it doesn't silently auto-fill the stale one).
window.addEventListener('engawa-auth-error', () => {
  clearStoredPass();
  showPassStep();
  passError.classList.remove('hidden');
});

void initLogin();
