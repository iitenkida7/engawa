import { App } from '@/core/app';
import {
  clearEntryToken,
  ENTRY_TOKEN_PARAM,
  loadEntryToken,
  pickEntryToken,
  storeEntryToken,
  urlWithoutEntryToken,
} from '@/core/entry-token';
import { applyI18n, getLang, type Lang, setLang } from '@/core/i18n';
import { AvatarEditor } from '@/ui/avatar-editor';
import { loadProfileImage } from '@/ui/profile-image';
import { initialsOf } from '@/world/player';

const joinOverlay = document.getElementById('join-overlay') as HTMLDivElement;
const passForm = document.getElementById('join-pass-form') as HTMLFormElement;
const passInput = document.getElementById('join-password') as HTMLInputElement;
const passError = document.getElementById('join-pass-error') as HTMLDivElement;
const passRemember = document.getElementById('join-pass-remember') as HTMLInputElement;
const nameForm = document.getElementById('join-form') as HTMLFormElement;
const nameInput = document.getElementById('join-name') as HTMLInputElement;
const entryErrorCard = document.getElementById('join-entry-error') as HTMLDivElement;
const btnAvatarPre = document.getElementById('btn-avatar-pre') as HTMLButtonElement;
const avatarThumb = document.getElementById('join-avatar-thumb') as HTMLDivElement;
const canvas = document.getElementById('canvas') as HTMLCanvasElement;

// Show the current profile picture on the join screen; with none, fall back to
// the name's initials — the same camera-off placeholder you'd see in a room.
function renderJoinAvatarThumb() {
  const img = loadProfileImage();
  avatarThumb.replaceChildren();
  if (img) {
    const el = new Image();
    el.src = img;
    el.alt = '';
    avatarThumb.appendChild(el);
    avatarThumb.classList.remove('is-initials');
  } else {
    avatarThumb.textContent = initialsOf(nameInput.value);
    avatarThumb.classList.add('is-initials');
  }
}

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
renderJoinAvatarThumb();
// Keep the initials fallback in step with the name field as it's typed.
nameInput.addEventListener('input', renderJoinAvatarThumb);
// Refresh the join thumbnail when the editor changes the picture (applied
// immediately there, so the callback carries the new value).
btnAvatarPre.addEventListener('click', () =>
  editor.open({ onProfileImage: () => renderJoinAvatarThumb(), name: nameInput.value }),
);

let app: App | null = null;
// Password verified at the gate; sent on join. '' when the space is open.
let verifiedPassword = '';
// Entry ticket (docs/entry-token.md), when this office is gated by one. '' in
// the ordinary password/open modes, where there is no ticket to carry.
let entryToken = '';

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
  entryErrorCard.classList.add('hidden');
  nameForm.classList.remove('hidden');
  nameInput.focus();
}

function showPassStep() {
  nameForm.classList.add('hidden');
  entryErrorCard.classList.add('hidden');
  passForm.classList.remove('hidden');
  passError.classList.add('hidden');
  passInput.focus();
}

// Entry-ticket mode, no usable ticket: a dead end on purpose. The way in is a
// fresh link from whoever runs this office, so there is nothing to retry here.
function showEntryErrorStep() {
  passForm.classList.add('hidden');
  nameForm.classList.add('hidden');
  entryErrorCard.classList.remove('hidden');
}

// Entry-ticket mode, ticket in hand: straight to the name step, with the name
// field taken out — the name is the ticket's, not ours to type. The step stays
// (rather than joining on its own) so the avatar can still be set, and so entry
// is a click: browsers only let sound play after one.
function showTicketStep() {
  nameInput.value = '';
  nameInput.required = false;
  nameInput.classList.add('hidden');
  showNameStep();
  renderJoinAvatarThumb();
}

// On load, ask the server whether a password is required. Only then show the
// password gate before the name step; otherwise go straight to the name step
// (an open space never asks for a password).
async function initLogin() {
  let passwordRequired = false;
  let entryMode = 'password';
  try {
    const res = await fetch('/api/config');
    const cfg = (await res.json()) as { passwordRequired?: boolean; entryMode?: string };
    passwordRequired = !!cfg.passwordRequired;
    entryMode = cfg.entryMode === 'token' ? 'token' : 'password';
  } catch {
    passwordRequired = false;
  }
  if (entryMode === 'token') {
    initTicketLogin();
    return;
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

// Entry-ticket mode: the ticket arrives in the link (`/?t=…`) and is kept for
// the rest of its life, so a reload or a dropped connection doesn't send the
// person back to the control plane to be let in again. It is stripped from the
// address bar immediately — a query string is the most quoted, screenshotted
// and Referer-leaked part of a URL, and this one is a credential.
function initTicketLogin() {
  const fromUrl = new URL(window.location.href).searchParams.get(ENTRY_TOKEN_PARAM);
  const cleaned = urlWithoutEntryToken(window.location.href);
  if (cleaned) history.replaceState(history.state, '', cleaned);

  const token = pickEntryToken(fromUrl, loadEntryToken());
  if (!token) {
    clearEntryToken();
    showEntryErrorStep();
    return;
  }
  storeEntryToken(token);
  entryToken = token;
  showTicketStep();
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
  // With a ticket there is no name to give: the server reads it off the ticket.
  if (!name && !entryToken) return;
  if (name) localStorage.setItem('engawa-name', name);
  joinOverlay.classList.add('hidden');

  if (!app) {
    app = new App({ canvas, editor });
  }
  app.start(name, verifiedPassword, entryToken);
});

// If a later join is rejected (e.g. the password changed), the App re-shows the
// overlay; the remembered passphrase is now wrong, so drop it and restart at the
// gate with the error visible (so it doesn't silently auto-fill the stale one).
window.addEventListener('engawa-auth-error', () => {
  // A ticket that stopped working (expired, or the office rotated its key):
  // drop it and say so. Retrying with the same one would only fail again.
  if (entryToken) {
    entryToken = '';
    clearEntryToken();
    showEntryErrorStep();
    return;
  }
  clearStoredPass();
  showPassStep();
  passError.classList.remove('hidden');
});

void initLogin();
