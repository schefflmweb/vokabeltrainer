/**
 * Replaces the old Azure/MSAL/OneDrive setup with a plain GitHub Personal
 * Access Token (PAT), scoped to `gist` only. No app registration, no
 * redirect flow — the user creates a token once (github.com/settings/tokens,
 * classic token, `gist` scope) and pastes it in.
 *
 * Stored in IndexedDB (via db.js's meta store, same place the app already
 * keeps the streak/lastSync settings) rather than only localStorage — plain
 * localStorage can get cleared by browser privacy settings (e.g. Safari's
 * "Block all cookies", which also blocks localStorage) independently of
 * IndexedDB, and losing just this one key silently meant having to re-paste
 * the token on next launch with no explanation. localStorage is still
 * written as a second copy for resilience and to pick up a token saved by
 * an earlier version of this file; IndexedDB is authoritative when present.
 */

import { db } from '../data/db.js';

const TOKEN_META_KEY = 'githubToken';
const TOKEN_LS_KEY = 'vocab-github-pat';

function readLocalStorage(key) {
  try { return localStorage.getItem(key) || ''; } catch { return ''; }
}

function writeLocalStorage(key, value) {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    // Best-effort only — db.setMeta below is the persistence that's verified.
  }
}

let tokenCache = '';
let loadPromise = null;

async function load() {
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    const dbToken = await db.getMeta(TOKEN_META_KEY);
    tokenCache = dbToken || readLocalStorage(TOKEN_LS_KEY) || '';
  })();
  return loadPromise;
}

export const githubAuth = {
  /** Must resolve before isConfigured()/getToken() are trustworthy — call once before first use (see manageMode.js/syncService.js). */
  async ready() {
    await load();
  },

  isConfigured() {
    return !!tokenCache;
  },

  getToken() {
    return tokenCache;
  },

  /**
   * Saves the token and reads it straight back from IndexedDB to confirm it
   * actually persisted, throwing a clear error instead of silently
   * pretending to succeed — a storage write that quietly fails (private
   * browsing, a full/blocked storage quota) is exactly what makes this look
   * like "I have to paste the token in again every time" days later.
   */
  async setToken(token) {
    await load();
    const trimmed = token.trim();
    tokenCache = trimmed;
    writeLocalStorage(TOKEN_LS_KEY, trimmed);
    await db.setMeta(TOKEN_META_KEY, trimmed);
    const confirmed = await db.getMeta(TOKEN_META_KEY);
    if (confirmed !== trimmed) {
      throw new Error('Token konnte nicht dauerhaft gespeichert werden — evtl. privater/eingeschränkter Browser-Modus.');
    }
  },

  async disconnect() {
    await load();
    tokenCache = '';
    writeLocalStorage(TOKEN_LS_KEY, '');
    await db.setMeta(TOKEN_META_KEY, '');
  }
};
