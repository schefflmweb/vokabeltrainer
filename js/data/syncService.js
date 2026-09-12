import { githubAuth } from '../auth/githubAuth.js';
import { vocabStore } from './vocabStore.js';
import { grammarStore } from './grammarStore.js';
import { db } from './db.js';

const API_BASE = 'https://api.github.com';
// Marks the gist as "ours" so a second device signed in with the same token
// finds and reuses it instead of creating a duplicate — the equivalent of
// OneDrive's fixed "Apps/Vokabeltrainer" app-folder path.
const GIST_DESCRIPTION = 'Vokabeltrainer-Daten (bitte nicht löschen)';

/** Each collection is one file inside the same gist, synced together in a single pull→merge→push pass. */
const COLLECTIONS = [
  { store: vocabStore, fileName: 'vocab-data.json', field: 'vocab' },
  { store: grammarStore, fileName: 'grammar-data.json', field: 'grammar' }
];

let listeners = [];
let status = { state: 'offline', message: 'Nur lokal gespeichert', lastSync: null };
let syncPromise = null;
let scheduleTimer = null;
const SCHEDULE_DEBOUNCE_MS = 3000;

function setStatus(next) {
  status = { ...status, ...next };
  listeners.forEach((fn) => fn(status));
}

function authHeaders(token) {
  // "token <PAT>" — the classic, universally-supported scheme for personal
  // access tokens. "Bearer" is also documented for the REST API but is more
  // associated with GitHub Apps/OAuth tokens; using "token" here removes any
  // doubt for a plain PAT.
  return {
    Authorization: `token ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28'
  };
}

const NETWORK_RETRY_DELAYS_MS = [800, 1600, 3200];

/**
 * A plain fetch() throwing (rather than resolving with an error status)
 * means the request never reached a server at all — DNS/TLS/connection
 * refused, distinct from GitHub responding with e.g. a 401. Antivirus/
 * firewall HTTPS scanning (which intercepts the connection to inspect it)
 * is a common, well-documented cause of exactly this kind of *intermittent*
 * failure — some requests get through, some don't — so this retries a few
 * times with increasing delay before giving up, rather than once.
 */
async function fetchWithRetry(url, options, attempt = 0) {
  try {
    return await fetch(url, options);
  } catch (err) {
    if (attempt < NETWORK_RETRY_DELAYS_MS.length) {
      await new Promise((r) => setTimeout(r, NETWORK_RETRY_DELAYS_MS[attempt]));
      return fetchWithRetry(url, options, attempt + 1);
    }
    throw new Error('Verbindung zu GitHub nicht möglich — evtl. blockiert ein Antivirus-Programm (HTTPS-Scan), eine Browser-Erweiterung oder eine Firewall den Zugriff auf api.github.com. Bitte kurz erneut versuchen.');
  }
}

/** Turns a non-ok response into a message that actually helps for the two most common causes (bad token, missing scope) instead of just a bare status code. */
function httpErrorMessage(res, context) {
  if (res.status === 401) {
    return 'GitHub lehnt den Token ab (401) — bitte prüfen: vollständig kopiert (kein Leerzeichen/Zeilenumbruch abgeschnitten), noch nicht abgelaufen oder widerrufen, und als "classic" Token erstellt (nicht "fine-grained" — die unterstützen keine Gists).';
  }
  if (res.status === 403) {
    return 'GitHub verweigert den Zugriff (403) — hat der Token die Berechtigung "gist"?';
  }
  return `${context} (${res.status})`;
}

/** Finds the gist created by a previous sync (on this or another device with the same token) rather than creating a duplicate every time localStorage doesn't already have the id cached. */
async function findExistingGistId(token) {
  const res = await fetchWithRetry(`${API_BASE}/gists?per_page=100`, { headers: authHeaders(token) });
  if (!res.ok) throw new Error(httpErrorMessage(res, 'GitHub-Abruf fehlgeschlagen'));
  const gists = await res.json();
  const match = gists.find((g) => g.description === GIST_DESCRIPTION);
  return match ? match.id : null;
}

async function createGist(token) {
  const files = Object.fromEntries(
    COLLECTIONS.map(({ fileName, field }) => [
      fileName,
      { content: JSON.stringify({ [field]: [], savedAt: new Date().toISOString() }) }
    ])
  );
  const res = await fetchWithRetry(`${API_BASE}/gists`, {
    method: 'POST',
    headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ description: GIST_DESCRIPTION, public: false, files })
  });
  if (!res.ok) throw new Error(httpErrorMessage(res, 'Gist anlegen fehlgeschlagen'));
  const created = await res.json();
  return created.id;
}

async function resolveGistId(token) {
  const cached = githubAuth.getGistId();
  if (cached) return cached;
  const found = await findExistingGistId(token);
  const id = found || await createGist(token);
  await githubAuth.setGistId(id);
  return id;
}

/** Files over ~1MB come back with `content` omitted and `truncated: true` — the vocab file alone exceeds that once a large CSV has been imported, so those need a second fetch against raw_url. */
async function fetchGistFiles(token, gistId) {
  const res = await fetchWithRetry(`${API_BASE}/gists/${gistId}`, { headers: authHeaders(token) });
  if (res.status === 404) {
    // The cached gist id no longer exists (deleted on github.com, say) — drop it so the next sync creates/finds a fresh one instead of failing forever.
    await githubAuth.setGistId('');
    throw new Error('Gist nicht gefunden — bitte erneut synchronisieren');
  }
  if (!res.ok) throw new Error(httpErrorMessage(res, 'GitHub-Abruf fehlgeschlagen'));
  const gist = await res.json();
  const files = gist.files || {};
  await Promise.all(Object.values(files).map(async (file) => {
    if (file.truncated && file.raw_url) {
      const rawRes = await fetchWithRetry(file.raw_url, { headers: authHeaders(token) });
      if (rawRes.ok) file.content = await rawRes.text();
    }
  }));
  return files;
}

async function pushGistFiles(token, gistId, filesPayload) {
  const res = await fetchWithRetry(`${API_BASE}/gists/${gistId}`, {
    method: 'PATCH',
    headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ files: filesPayload })
  });
  if (!res.ok) throw new Error(httpErrorMessage(res, 'GitHub-Speichern fehlgeschlagen'));
}

function parseRemoteRecords(file, field) {
  if (!file?.content) return null;
  try {
    const body = JSON.parse(file.content);
    return body[field] || [];
  } catch {
    return null;
  }
}

export const syncService = {
  onStatusChange(fn) {
    listeners.push(fn);
    fn(status);
    return () => {
      listeners = listeners.filter((l) => l !== fn);
    };
  },

  getStatus() {
    return status;
  },

  /** Runs a sync now. Concurrent calls join the same in-flight run instead of firing overlapping requests. */
  sync() {
    if (syncPromise) return syncPromise;
    syncPromise = this._runSync().finally(() => {
      syncPromise = null;
    });
    return syncPromise;
  },

  /**
   * Opportunistic sync for high-frequency call sites (e.g. after every card
   * review) — coalesces bursts into a single run a few seconds after the
   * last request instead of hitting the API once per review.
   */
  scheduleSync() {
    clearTimeout(scheduleTimer);
    scheduleTimer = setTimeout(() => this.sync(), SCHEDULE_DEBOUNCE_MS);
  },

  async _runSync() {
    await githubAuth.ready();
    const token = githubAuth.getToken();
    if (!token) {
      setStatus({ state: 'signed-out', message: 'Nicht verbunden – arbeitet lokal weiter' });
      return;
    }

    setStatus({ state: 'syncing', message: 'Synchronisiere …' });
    try {
      const gistId = await resolveGistId(token);
      const files = await fetchGistFiles(token, gistId);

      const pushPayload = {};
      for (const { store, fileName, field } of COLLECTIONS) {
        const remoteRecords = parseRemoteRecords(files[fileName], field);
        const merged = await store.mergeFromRemote(remoteRecords);
        pushPayload[fileName] = { content: JSON.stringify({ [field]: merged, savedAt: new Date().toISOString() }) };
      }
      await pushGistFiles(token, gistId, pushPayload);

      for (const { store } of COLLECTIONS) {
        const dirty = await store.getDirty();
        await store.clearDirty(dirty.map((d) => d.id));
      }

      await db.setMeta('lastSync', Date.now());
      setStatus({ state: 'synced', message: 'Synchronisiert', lastSync: Date.now() });
    } catch (err) {
      setStatus({ state: 'error', message: err.message || 'Sync-Fehler – arbeitet lokal weiter' });
    }
  }
};
