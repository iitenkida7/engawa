import { Game } from './game';

const joinOverlay = document.getElementById('join-overlay') as HTMLDivElement;
const joinForm = document.getElementById('join-form') as HTMLFormElement;
const joinNameInput = document.getElementById('join-name') as HTMLInputElement;
const canvas = document.getElementById('canvas') as HTMLCanvasElement;

const stored = localStorage.getItem('gather-clone-name');
if (stored) joinNameInput.value = stored;

joinForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const name = joinNameInput.value.trim();
  if (!name) return;
  localStorage.setItem('gather-clone-name', name);
  joinOverlay.classList.add('hidden');

  const game = new Game({ canvas });
  game.start(name);
});
