import { App } from '@/core/app';
import { AvatarEditor } from '@/ui/avatar-editor';

const joinOverlay = document.getElementById('join-overlay') as HTMLDivElement;
const joinForm = document.getElementById('join-form') as HTMLFormElement;
const joinNameInput = document.getElementById('join-name') as HTMLInputElement;
const joinPasswordInput = document.getElementById('join-password') as HTMLInputElement;
const btnAvatarPre = document.getElementById('btn-avatar-pre') as HTMLButtonElement;
const canvas = document.getElementById('canvas') as HTMLCanvasElement;

const stored = localStorage.getItem('engawa-name');
if (stored) joinNameInput.value = stored;

// One editor instance, shared between the join screen (pre-join) and the App's
// in-room 🧍 button. App reads the persisted outfit on join (see app.ts).
const editor = new AvatarEditor();
btnAvatarPre.addEventListener('click', () => editor.open());

let app: App | null = null;

joinForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const name = joinNameInput.value.trim();
  if (!name) return;
  localStorage.setItem('engawa-name', name);
  const password = joinPasswordInput.value;
  joinOverlay.classList.add('hidden');

  if (!app) {
    app = new App({ canvas, editor });
  }
  app.start(name, password);
});
