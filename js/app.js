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

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') syncService.sync();
});
window.addEventListener('online', () => syncService.sync());

if ('serviceWorker' in navigator) {
  // sw.js caches files stale-while-revalidate (serve the cached copy
  // immediately, refresh it in the background for next time) — good for
  // instant loads, but it means a page left open, or just reopened without
  // a full reload, can end up running a mix of old and newly-deployed files
  // rather than one consistent version, until it happens to reload. Once a
  // new service worker actually takes over (which only happens when sw.js
  // itself changed, e.g. a CACHE_VERSION bump), force a one-time reload so
  // every file comes from that new version together.
  let reloadedForNewWorker = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloadedForNewWorker) return;
    reloadedForNewWorker = true;
    location.reload();
  });
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

const initial = (location.hash || '#audio').slice(1);
showMode(modes[initial] ? initial : 'audio');
syncService.sync();
