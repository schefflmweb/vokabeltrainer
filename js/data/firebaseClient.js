/**
 * Loads the Firebase SDK lazily from its CDN, on first actual use, rather
 * than as a static import — firebaseAuth.js and syncService.js both import
 * this file at their own top level, and a static SDK import there would
 * make a fully offline app load (no cached copy of the CDN module yet)
 * fail to even evaluate those modules, breaking app.js's own top-level
 * import of syncService.js and taking the whole app down with it. Loading
 * lazily means an offline/CDN-unreachable load only fails the sync itself
 * (same as "no network" already did with the previous GitHub Gist sync),
 * never local-only use of the app.
 */

const SDK_VERSION = '10.14.1';

// Firebase's apiKey/projectId etc. are not secrets — they identify the
// project, not authorize access. Real access control is Firestore's own
// security rules (locked to one specific user UID) plus requiring a signed-
// in Firebase Auth session, both enforced server-side regardless of what a
// client sends.
const FIREBASE_CONFIG = {
  apiKey: 'AIzaSyBdi7uLbEvWw2gPVOUHYgg3v9B9OV2cWzw',
  authDomain: 'vokabeltrainer-74a5e.firebaseapp.com',
  projectId: 'vokabeltrainer-74a5e',
  storageBucket: 'vokabeltrainer-74a5e.firebasestorage.app',
  messagingSenderId: '974896911947',
  appId: '1:974896911947:web:12ea65e2d8a13404415fce'
};

let loadPromise = null;

/**
 * Resolves once with { auth, authFns, db, dbFns } — safe to call from
 * anywhere repeatedly, the actual CDN load and app init only happen once.
 * Rejects if offline/unreachable; callers must treat that as "sync
 * unavailable right now", not a fatal error, and are free to call this
 * again later (a failed attempt isn't cached, so the next call retries).
 */
export async function getFirebase() {
  if (!loadPromise) {
    loadPromise = (async () => {
      const base = `https://www.gstatic.com/firebasejs/${SDK_VERSION}`;
      const [{ initializeApp }, authFns, dbFns] = await Promise.all([
        import(`${base}/firebase-app.js`),
        import(`${base}/firebase-auth.js`),
        import(`${base}/firebase-firestore.js`)
      ]);
      const app = initializeApp(FIREBASE_CONFIG);
      return { auth: authFns.getAuth(app), authFns, db: dbFns.getFirestore(app), dbFns };
    })().catch((err) => {
      loadPromise = null;
      throw err;
    });
  }
  return loadPromise;
}
