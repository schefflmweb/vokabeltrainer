const CACHE_VERSION = 'vokabeltrainer-v62';
const APP_SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/styles.css',
  './js/app.js',
  './js/version.js',
  './js/data/db.js',
  './js/data/streak.js',
  './js/data/vocabStore.js',
  './js/data/grammarStore.js',
  './js/data/idiomStore.js',
  './js/data/practicePool.js',
  './js/data/deviceRole.js',
  './js/data/deletionQueue.js',
  './js/data/remoteMerge.js',
  './js/data/practiceFilter.js',
  './js/data/challengeQuestions.js',
  './js/data/distractorPairs.js',
  './js/data/challengeStore.js',
  './js/data/syncService.js',
  './js/data/firebaseClient.js',
  './js/auth/firebaseAuth.js',
  './js/srs/scheduler.js',
  './js/tts/ttsService.js',
  './js/stt/speechInputService.js',
  './js/util/answerMatch.js',
  './js/audio/toneService.js',
  './js/audio/audioSessionUnlock.js',
  './js/ui/progressBar.js',
  './js/ui/flags.js',
  './js/ui/icons.js',
  './js/ui/practiceFilterBox.js',
  './js/modes/audioMode.js',
  './js/modes/quizMode.js',
  './js/modes/grammarMode.js',
  './js/modes/challengeMode.js',
  './js/modes/manageMode.js',
  './js/csv/csvImport.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
  './icons/favicon-64.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => {
      // { cache: 'reload' } forces each of these past the browser's own
      // HTTP cache — without it, precaching a "new" version could still
      // pull an already-stale response straight out of that cache, making
      // the update a no-op even though a genuinely new service worker
      // installed. This was likely why the manual refresh button (which
      // only clears the Cache Storage API and service worker registration,
      // neither of which is the browser's HTTP cache) wasn't always enough
      // on its own.
      const requests = APP_SHELL.map((url) => new Request(url, { cache: 'reload' }));
      return cache.addAll(requests);
    }).then(() => self.skipWaiting())
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
  // Only cache the app's own same-origin files — never GitHub API calls or anything else external.
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(request).then((cached) => {
      // Same reasoning as install's precache fetch: bypass the browser's
      // own HTTP cache so this background revalidation can actually notice
      // a file changed, instead of re-confirming a stale cached response.
      const network = fetch(request, { cache: 'reload' })
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
