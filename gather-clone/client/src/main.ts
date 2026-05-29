import { Game } from './game';

const joinOverlay = document.getElementById('join-overlay') as HTMLDivElement;
const joinForm = document.getElementById('join-form') as HTMLFormElement;
const joinNameInput = document.getElementById('join-name') as HTMLInputElement;
const joinPasswordInput = document.getElementById('join-password') as HTMLInputElement;
const canvas = document.getElementById('canvas') as HTMLCanvasElement;

const stored = localStorage.getItem('gather-clone-name');
if (stored) joinNameInput.value = stored;

let game: Game | null = null;

joinForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const name = joinNameInput.value.trim();
  if (!name) return;
  localStorage.setItem('gather-clone-name', name);
  const password = joinPasswordInput.value;
  joinOverlay.classList.add('hidden');

  if (!game) {
    game = new Game({ canvas });
  }
  game.start(name, password);
});
