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
const GIST_ID_META_KEY = 'githubGistId';
const TOKEN_LS_KEY = 'vocab-github-pat';
const GIST_ID_LS_KEY = 'vocab-github-gist-id';

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
let gistIdCache = '';
let loadPromise = null;

async function load() {
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    const [dbToken, dbGistId] = await Promise.all([db.getMeta(TOKEN_META_KEY), db.getMeta(GIST_ID_META_KEY)]);
    tokenCache = dbToken || readLocalStorage(TOKEN_LS_KEY) || '';
    gistIdCache = dbGistId || readLocalStorage(GIST_ID_LS_KEY) || '';
  })();
  return loadPromise;
}

export const githubAuth = {
  /** Must resolve before isConfigured()/getToken()/getGistId() are trustworthy — call once before first use (see manageMode.js/syncService.js). */
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

  /** The gist syncService reads/writes to, once found or created — cached so repeat syncs don't have to search for it every time. */
  getGistId() {
    return gistIdCache;
  },

  async setGistId(id) {
    await load();
    gistIdCache = id;
    writeLocalStorage(GIST_ID_LS_KEY, id);
    await db.setMeta(GIST_ID_META_KEY, id);
  },

  async disconnect() {
    await load();
    tokenCache = '';
    gistIdCache = '';
    writeLocalStorage(TOKEN_LS_KEY, '');
    writeLocalStorage(GIST_ID_LS_KEY, '');
    await Promise.all([db.setMeta(TOKEN_META_KEY, ''), db.setMeta(GIST_ID_META_KEY, '')]);
  }
};
