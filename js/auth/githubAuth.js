/**
 * Replaces the old Azure/MSAL/OneDrive setup with a plain GitHub Personal
 * Access Token (PAT), scoped to `gist` only. No app registration, no
 * redirect flow — the user creates a token once (github.com/settings/tokens,
 * classic token, `gist` scope) and pastes it in. Stored in localStorage,
 * same trust model as the token MSAL used to cache there.
 */

const TOKEN_KEY = 'vocab-github-pat';
const GIST_ID_KEY = 'vocab-github-gist-id';

function readLocal(key) {
  try { return localStorage.getItem(key) || ''; } catch { return ''; }
}

function writeLocal(key, value) {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    // Falls back to in-memory-only for this session.
  }
}

export const githubAuth = {
  isConfigured() {
    return !!readLocal(TOKEN_KEY);
  },

  getToken() {
    return readLocal(TOKEN_KEY);
  },

  setToken(token) {
    writeLocal(TOKEN_KEY, token.trim());
  },

  /** The gist syncService reads/writes to, once found or created — cached so repeat syncs don't have to search for it every time. */
  getGistId() {
    return readLocal(GIST_ID_KEY);
  },

  setGistId(id) {
    writeLocal(GIST_ID_KEY, id);
  },

  disconnect() {
    writeLocal(TOKEN_KEY, '');
    writeLocal(GIST_ID_KEY, '');
  }
};
