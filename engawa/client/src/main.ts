import { App } from './app';

const joinOverlay = document.getElementById('join-overlay') as HTMLDivElement;
const joinForm = document.getElementById('join-form') as HTMLFormElement;
const joinNameInput = document.getElementById('join-name') as HTMLInputElement;
const joinPasswordInput = document.getElementById('join-password') as HTMLInputElement;
const canvas = document.getElementById('canvas') as HTMLCanvasElement;

const stored = localStorage.getItem('engawa-name');
if (stored) joinNameInput.value = stored;

let app: App | null = null;

joinForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const name = joinNameInput.value.trim();
  if (!name) return;
  localStorage.setItem('engawa-name', name);
  const password = joinPasswordInput.value;
  joinOverlay.classList.add('hidden');

  if (!app) {
    app = new App({ canvas });
  }
  app.start(name, password);
});
