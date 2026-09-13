/**
 * Replaces the GitHub Personal Access Token flow with Firebase's built-in
 * email/password sign-in. No redirect/popup dance (that's what made the
 * original Azure/MSAL/OneDrive design flaky on iOS PWAs) — just a form and
 * one SDK call, and Firebase's own IndexedDB-backed session persistence
 * means a device only needs to sign in once, same as before.
 *
 * The email/password account itself isn't created by this app — it's added
 * once, manually, in the Firebase console (see SETUP-FIREBASE-SYNC.md), and
 * Firestore's security rules lock all access to that one specific user UID.
 * This module only ever signs IN, never up, so there's no way for anyone
 * else to self-register their way into passing that check.
 */

import { getFirebase } from '../data/firebaseClient.js';

let listeners = [];
let currentUser = null;
let readyPromise = null;

async function load() {
  if (readyPromise) return readyPromise;
  readyPromise = (async () => {
    const { auth, authFns } = await getFirebase();
    await new Promise((resolve) => {
      let settled = false;
      authFns.onAuthStateChanged(auth, (user) => {
        currentUser = user;
        listeners.forEach((fn) => fn(user));
        if (!settled) {
          settled = true;
          resolve();
        }
      });
    });
  })();
  return readyPromise;
}

/** Turns a Firebase Auth error code into a message that actually helps, instead of a raw error string. */
export function authErrorMessage(err) {
  const code = err?.code || '';
  if (code === 'auth/invalid-credential' || code === 'auth/wrong-password' || code === 'auth/user-not-found') {
    return 'E-Mail oder Passwort falsch.';
  }
  if (code === 'auth/invalid-email') {
    return 'Ungültige E-Mail-Adresse.';
  }
  if (code === 'auth/too-many-requests') {
    return 'Zu viele Versuche — bitte kurz warten und erneut versuchen.';
  }
  if (code === 'auth/network-request-failed') {
    return 'Keine Verbindung zu Firebase möglich — bitte Internetverbindung prüfen.';
  }
  return err?.message || 'Anmeldung fehlgeschlagen.';
}

export const firebaseAuth = {
  /**
   * Must resolve before isConfigured()/getEmail() are trustworthy — call
   * once before first use (see manageMode.js/syncService.js). Never
   * throws: a failed SDK load (offline, CDN unreachable on a first-ever
   * load) just leaves the app signed-out, same as "no token" did before —
   * sync stays unavailable until the next successful call.
   */
  async ready() {
    try {
      await load();
    } catch {
      readyPromise = null;
    }
  },

  isConfigured() {
    return !!currentUser;
  },

  getEmail() {
    return currentUser?.email || '';
  },

  /** Subscribe to sign-in/sign-out changes (including the initial state once known) — used to keep the Verwalten UI in sync. */
  onAuthChange(fn) {
    listeners.push(fn);
    if (readyPromise) fn(currentUser);
    return () => {
      listeners = listeners.filter((l) => l !== fn);
    };
  },

  async signIn(email, password) {
    const { auth, authFns } = await getFirebase();
    await authFns.signInWithEmailAndPassword(auth, email, password);
  },

  async disconnect() {
    const { auth, authFns } = await getFirebase();
    await authFns.signOut(auth);
  }
};
