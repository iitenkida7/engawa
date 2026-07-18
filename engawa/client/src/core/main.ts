import { App } from '@/core/app';
import { AvatarEditor } from '@/ui/avatar-editor';

const joinOverlay = document.getElementById('join-overlay') as HTMLDivElement;
const passForm = document.getElementById('join-pass-form') as HTMLFormElement;
const passInput = document.getElementById('join-password') as HTMLInputElement;
const passError = document.getElementById('join-pass-error') as HTMLDivElement;
const nameForm = document.getElementById('join-form') as HTMLFormElement;
const nameInput = document.getElementById('join-name') as HTMLInputElement;
const btnAvatarPre = document.getElementById('btn-avatar-pre') as HTMLButtonElement;
const canvas = document.getElementById('canvas') as HTMLCanvasElement;

const stored = localStorage.getItem('engawa-name');
if (stored) nameInput.value = stored;

// One editor instance, shared between the join screen (pre-join) and the App's
// in-room 🧍 button. App reads the persisted outfit on join (see app.ts).
const editor = new AvatarEditor();
btnAvatarPre.addEventListener('click', () => editor.open());

let app: App | null = null;
// Password verified at the gate; sent on join. '' when the space is open.
let verifiedPassword = '';

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
  if (passwordRequired) showPassStep();
  else showNameStep();
}

passForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const password = passInput.value;
  passError.classList.add('hidden');
  let ok = false;
  try {
    const res = await fetch('/api/verify-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    ok = !!((await res.json()) as { ok?: boolean }).ok;
  } catch {
    ok = false;
  }
  if (!ok) {
    passError.classList.remove('hidden');
    return;
  }
  verifiedPassword = password;
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
// overlay; restart at the password gate with the error visible.
window.addEventListener('engawa-auth-error', () => {
  showPassStep();
  passError.classList.remove('hidden');
});

void initLogin();
