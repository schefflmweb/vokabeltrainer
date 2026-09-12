import { authService } from './auth/authService.js';
import { syncService } from './data/syncService.js';
import * as audioMode from './modes/audioMode.js';
import * as quizMode from './modes/quizMode.js';
import * as grammarMode from './modes/grammarMode.js';
import * as manageMode from './modes/manageMode.js';
import { refreshIcon } from './ui/icons.js';

const modes = { audio: audioMode, quiz: quizMode, grammar: grammarMode, manage: manageMode };
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

/**
 * The service worker serves cached files first and only refreshes them in
 * the background (see sw.js), so a device can stay on an old version for a
 * while after a new one is deployed. This button forces a clean pickup: drop
 * the service worker and its cache, then reload — the next load re-registers
 * a fresh worker and re-caches everything from the network.
 */
const refreshBtn = document.getElementById('refresh-app-btn');
if (refreshBtn) {
  refreshBtn.innerHTML = refreshIcon;
  refreshBtn.addEventListener('click', async () => {
    if (refreshBtn.classList.contains('is-refreshing')) return;
    refreshBtn.classList.add('is-refreshing');
    try {
      if ('serviceWorker' in navigator) {
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map((r) => r.unregister()));
      }
      if ('caches' in window) {
        const keys = await caches.keys();
        await Promise.all(keys.map((k) => caches.delete(k)));
      }
    } catch {
      // Fall through to reload regardless — worst case the old cache stays,
      // same as before the tap.
    }
    location.reload();
  });
}

/**
 * Renders the initial mode right away rather than waiting on auth/MSAL
 * first — auth setup (in particular waiting for the MSAL script and any
 * silent-token check) can take a moment, especially on a network that's
 * slower to reach an external CDN than the app's own already-cached files,
 * and there's no reason the UI itself should sit blank for that.
 */
function showInitialMode() {
  const initial = (location.hash || '#audio').slice(1);
  showMode(modes[initial] ? initial : 'audio');
}

async function initAuth() {
  await authService.ready();
  // May navigate away and back (interactive re-login) if the cached session
  // has expired — only safe to do here, before periodic/background sync
  // triggers exist (see authService.ensureSignedIn's own doc comment); the
  // initial mode is already showing by this point, not blocked on it.
  await authService.ensureSignedIn();
  triggerSync();
}

showInitialMode();
initAuth();
