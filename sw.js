const CACHE_VERSION = 'vokabeltrainer-v1';
const APP_SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/styles.css',
  './js/app.js',
  './js/data/db.js',
  './js/data/vocabStore.js',
  './js/data/syncService.js',
  './js/auth/authService.js',
  './js/srs/scheduler.js',
  './js/tts/ttsService.js',
  './js/stt/speechInputService.js',
  './js/util/answerMatch.js',
  './js/audio/toneService.js',
  './js/ui/progressBar.js',
  './js/ui/flags.js',
  './js/ui/icons.js',
  './js/modes/audioMode.js',
  './js/modes/quizMode.js',
  './js/modes/manageMode.js',
  './js/csv/csvImport.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
  './icons/favicon-64.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE_VERSION).map((key) => caches.delete(key)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  // Never intercept calls to Microsoft auth/graph endpoints — always go to network.
  if (url.origin.includes('login.microsoftonline.com') || url.origin.includes('graph.microsoft.com')) {
    return;
  }
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((response) => {
          if (response && response.ok) {
            const clone = response.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put(request, clone));
          }
          return response;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
