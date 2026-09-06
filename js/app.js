import { authService } from './auth/authService.js';
import { syncService } from './data/syncService.js';
import * as audioMode from './modes/audioMode.js';
import * as quizMode from './modes/quizMode.js';
import * as manageMode from './modes/manageMode.js';

const modes = { audio: audioMode, quiz: quizMode, manage: manageMode };
const view = document.getElementById('view');
const navButtons = document.querySelectorAll('.nav-btn');

let currentUnmount = null;

function showMode(name) {
  currentUnmount?.();
  view.innerHTML = '';
  navButtons.forEach((btn) => btn.classList.toggle('active', btn.dataset.mode === name));
  currentUnmount = modes[name].mount(view) || null;
  history.replaceState(null, '', `#${name}`);
}

navButtons.forEach((btn) => {
  btn.addEventListener('click', () => showMode(btn.dataset.mode));
});

function triggerSync() {
  authService.ready().then(() => syncService.sync());
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') triggerSync();
});
window.addEventListener('online', triggerSync);

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}

async function main() {
  await authService.ready();
  // May navigate away and back (interactive re-login) if the cached session
  // has expired — only safe to do here, before the user has picked a mode.
  await authService.ensureSignedIn();
  triggerSync();

  const initial = (location.hash || '#audio').slice(1);
  showMode(modes[initial] ? initial : 'audio');
}

main();
