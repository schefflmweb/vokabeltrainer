import { githubAuth } from '../auth/githubAuth.js';
import { vocabStore } from './vocabStore.js';
import { grammarStore } from './grammarStore.js';
import { db } from './db.js';

const API_BASE = 'https://api.github.com';
// Marks the gist as "ours" so a second device signed in with the same token
// finds and reuses it instead of creating a duplicate — the equivalent of
// OneDrive's fixed "Apps/Vokabeltrainer" app-folder path.
const GIST_DESCRIPTION = 'Vokabeltrainer-Daten (bitte nicht löschen)';

/**
 * Gist files over some threshold come back from the API with `content`
 * omitted (`truncated: true`) — readable only via a separate `raw_url`,
 * which lives on a different domain (gist.githubusercontent.com). That
 * domain's CORS preflight response rejects the Authorization header this
 * app needs to send for a private gist ("Response to preflight request
 * doesn't pass access control check"), so the browser blocks that fetch
 * outright — not fixable from this side, since it's the other server's CORS
 * policy. Instead, each collection is split across multiple gist files,
 * each kept safely under the threshold, so every read/write only ever
 * talks to api.github.com, which does support this properly.
 *
 * GitHub doesn't document the exact threshold precisely (commonly cited as
 * ~1MB), and a byte-accurate chunk targeting 800KB still got truncated in
 * practice — so this stays well clear of it with a large margin rather than
 * chasing the exact real number, since smaller files cost nothing but a
 * few more of them in the gist.
 */
const MAX_FILE_BYTES = 200 * 1024;

/** Each collection's records are stored as `<baseFileName>.json`, `<baseFileName>.part1.json`, `<baseFileName>.part2.json`, ... as needed. */
const COLLECTIONS = [
  { store: vocabStore, baseFileName: 'vocab-data', field: 'vocab' },
  { store: grammarStore, baseFileName: 'grammar-data', field: 'grammar' }
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

// Shows the last known state (and record counts) immediately on load,
// before this session's own first sync has had a chance to run/complete.
(async () => {
  const [lastSync, counts] = await Promise.all([db.getMeta('lastSync'), db.getMeta('lastSyncCounts')]);
  if (lastSync || counts) setStatus({ lastSync: lastSync || null, counts: counts || null });
})();

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

/** Every gist matching our description — normally exactly one, but earlier races (two devices independently creating one before either found the other's) or repeated manual resets could have left more than one lying around. */
async function findAllMatchingGistIds(token) {
  const res = await fetchWithRetry(`${API_BASE}/gists?per_page=100`, { headers: authHeaders(token) });
  if (!res.ok) throw new Error(httpErrorMessage(res, 'GitHub-Abruf fehlgeschlagen'));
  const gists = await res.json();
  return gists.filter((g) => g.description === GIST_DESCRIPTION).map((g) => g.id);
}

/** Finds the gist created by a previous sync (on this or another device with the same token) rather than creating a duplicate every time localStorage doesn't already have the id cached. If more than one exists, picks the first found — resetRemote() is the way to clean up the rest. */
async function findExistingGistId(token) {
  const ids = await findAllMatchingGistIds(token);
  return ids.length > 0 ? ids[0] : null;
}

async function createGist(token) {
  const files = Object.fromEntries(
    COLLECTIONS.map(({ baseFileName, field }) => [
      partFileName(baseFileName, 0),
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

/**
 * A 404 right after creating a gist (or right after writing to one, for
 * pushGistFiles's own verification read) can be GitHub's read path not yet
 * reflecting a write that only just happened, not the gist actually being
 * gone — so a lone immediate 404 is retried a couple of times with a short
 * delay before it's treated as real. A 404 that persists past that (e.g.
 * the gist was genuinely deleted on github.com) still drops the cached id
 * so the next sync creates/finds a fresh one instead of failing forever.
 */
const GIST_404_RETRY_DELAYS_MS = [700, 1500, 2500, 4000];

async function fetchGistFiles(token, gistId, attempt = 0) {
  const res = await fetchWithRetry(`${API_BASE}/gists/${gistId}`, { headers: authHeaders(token) });
  if (res.status === 404) {
    if (attempt < GIST_404_RETRY_DELAYS_MS.length) {
      await new Promise((r) => setTimeout(r, GIST_404_RETRY_DELAYS_MS[attempt]));
      return fetchGistFiles(token, gistId, attempt + 1);
    }
    await githubAuth.setGistId('');
    throw new Error('Gist nicht gefunden — bitte erneut synchronisieren');
  }
  if (!res.ok) throw new Error(httpErrorMessage(res, 'GitHub-Abruf fehlgeschlagen'));
  const gist = await res.json();
  return gist.files || {};
}

/**
 * Pushes files, then does a genuine, separate GET to verify none of them
 * come back truncated — the PATCH response's own echoed file list turned
 * out not to reflect real truncation (a file could look fine right in the
 * PATCH response and still show up truncated on the very next plain read,
 * on this device or another), so only an actual follow-up GET can be
 * trusted. Costs one extra request per sync, but catches an oversized
 * chunk on the device that wrote it instead of only ever surfacing later.
 */
async function pushGistFiles(token, gistId, filesPayload) {
  const res = await fetchWithRetry(`${API_BASE}/gists/${gistId}`, {
    method: 'PATCH',
    headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ files: filesPayload })
  });
  if (!res.ok) throw new Error(httpErrorMessage(res, 'GitHub-Speichern fehlgeschlagen'));

  const verifyFiles = await fetchGistFiles(token, gistId);
  const truncatedNames = Object.entries(verifyFiles)
    .filter(([, file]) => file.truncated)
    .map(([name]) => name);
  if (truncatedNames.length > 0) {
    throw new Error(`GitHub hat beim Hochladen ${truncatedNames.join(', ')} trotzdem gekürzt — bitte "Sync zurücksetzen" versuchen. Damit merkt dieses Gerät es sofort, statt dass es erst später auf einem anderen auffällt.`);
  }
}

function partFileName(baseFileName, index) {
  return index === 0 ? `${baseFileName}.json` : `${baseFileName}.part${index}.json`;
}

function partFileRegex(baseFileName) {
  const escaped = baseFileName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped}(?:\\.part(\\d+))?\\.json$`);
}

const utf8Encoder = new TextEncoder();
/** Actual UTF-8 byte length — JS string .length counts UTF-16 code units, which undercounts anything outside plain ASCII (ä/ö/ü/ß and friends all encode to 2+ bytes in UTF-8), so it understated real file size for German text and let chunks quietly grow past GitHub's real truncation threshold. */
function utf8ByteLength(str) {
  return utf8Encoder.encode(str).length;
}

/** Splits `records` into chunks that each stay under MAX_FILE_BYTES once JSON-serialized — always at least one chunk, even if empty, so the base file always exists. */
function chunkRecords(records) {
  const chunks = [];
  let current = [];
  let currentSize = 2; // "[" + "]"
  for (const record of records) {
    const size = utf8ByteLength(JSON.stringify(record)) + 1; // + comma/separator
    if (current.length > 0 && currentSize + size > MAX_FILE_BYTES) {
      chunks.push(current);
      current = [];
      currentSize = 2;
    }
    current.push(record);
    currentSize += size;
  }
  chunks.push(current);
  return chunks;
}

/**
 * Gathers every part file belonging to this collection (base + any .partN)
 * and concatenates their records — null if the collection has no files at
 * all yet (a brand-new gist). Throws rather than silently treating a
 * truncated file as empty: doing that used to make a sync push the
 * (incomplete) local copy over the real remote data, silently losing
 * whatever only existed remotely — a truncated file now stops the sync
 * instead, since chunking should prevent this outright going forward.
 */
function collectRemoteRecords(files, baseFileName, field) {
  const re = partFileRegex(baseFileName);
  const parts = [];
  for (const [name, file] of Object.entries(files)) {
    const m = name.match(re);
    if (!m) continue;
    parts.push({ index: m[1] ? parseInt(m[1], 10) : 0, name, file });
  }
  if (parts.length === 0) return null;
  parts.sort((a, b) => a.index - b.index);
  const records = [];
  for (const { name, file } of parts) {
    if (file?.truncated) {
      throw new Error(`GitHub hat "${name}" beim Lesen gekürzt — Sync abgebrochen, um keine Daten zu verlieren. Vermutlich eine Datei von vor diesem Fix. Bitte auf dem Gerät mit den vollständigen Daten erneut synchronisieren; hilft das nicht, den Gist "Vokabeltrainer-Daten" auf gist.github.com löschen (die App legt beim nächsten Sync automatisch einen neuen an).`);
    }
    if (!file?.content) continue;
    try {
      const body = JSON.parse(file.content);
      records.push(...(body[field] || []));
    } catch {
      // Skip an unparsable chunk rather than failing the whole sync.
    }
  }
  return records;
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

  /**
   * Deletes the remote gist (if one exists) and lets the next sync create a
   * fresh one from scratch — the escape hatch for a gist stuck in a state
   * no sync can read past (e.g. a truncated file from before this app
   * version), since every sync must successfully read before it can write,
   * so a broken remote otherwise blocks every device equally, including the
   * one with complete, correct local data. Only ever run this on the device
   * whose local data is actually complete/current — it becomes the new
   * source of truth for the fresh gist.
   */
  async resetRemote() {
    // Unlike sync()/scheduleSync(), never piggyback on an in-flight run —
    // that could silently return a plain sync() (against the still-broken
    // remote) instead of actually performing the reset the caller asked
    // for. Wait for it to settle, then run the reset for real.
    if (syncPromise) await syncPromise.catch(() => {});
    syncPromise = this._runReset().finally(() => {
      syncPromise = null;
    });
    return syncPromise;
  },

  async _runReset() {
    await githubAuth.ready();
    const token = githubAuth.getToken();
    if (!token) {
      setStatus({ state: 'signed-out', message: 'Nicht verbunden – arbeitet lokal weiter' });
      return;
    }
    setStatus({ state: 'syncing', message: 'Setze Sync zurück …' });
    try {
      // Delete every gist matching our description, not just the cached/first
      // one — repeated resets or two devices once racing to create a gist
      // independently can leave more than one lying around, and finding a
      // DIFFERENT stray (still-broken) one on a later sync is exactly what
      // made this keep failing after a reset that looked like it worked.
      const ids = new Set(await findAllMatchingGistIds(token));
      const cached = githubAuth.getGistId();
      if (cached) ids.add(cached);
      for (const id of ids) {
        const res = await fetchWithRetry(`${API_BASE}/gists/${id}`, { method: 'DELETE', headers: authHeaders(token) });
        if (!res.ok && res.status !== 404) throw new Error(httpErrorMessage(res, 'Zurücksetzen fehlgeschlagen'));
      }
      await githubAuth.setGistId('');
    } catch (err) {
      setStatus({ state: 'error', message: err.message || 'Zurücksetzen fehlgeschlagen' });
      return;
    }
    return this._runSync();
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
      const counts = {};
      for (const { store, baseFileName, field } of COLLECTIONS) {
        const remoteRecords = collectRemoteRecords(files, baseFileName, field);
        const merged = await store.mergeFromRemote(remoteRecords);
        // Tombstones (deleted: true) stay in the merged/pushed set so the
        // deletion itself propagates, but they're not real entries — don't
        // count them for the "how many are actually on the gist" display.
        counts[field] = merged.filter((r) => !r.deleted).length;
        const chunks = chunkRecords(merged);
        const savedAt = new Date().toISOString();
        chunks.forEach((chunk, i) => {
          pushPayload[partFileName(baseFileName, i)] = { content: JSON.stringify({ [field]: chunk, savedAt }) };
        });
        // Drop any leftover part files from a previous, larger sync (e.g. after "Alle löschen").
        const re = partFileRegex(baseFileName);
        for (const name of Object.keys(files)) {
          if (re.test(name) && !(name in pushPayload)) pushPayload[name] = null;
        }
      }
      await pushGistFiles(token, gistId, pushPayload);

      for (const { store } of COLLECTIONS) {
        const dirty = await store.getDirty();
        await store.clearDirty(dirty.map((d) => d.id));
      }

      await Promise.all([db.setMeta('lastSync', Date.now()), db.setMeta('lastSyncCounts', counts)]);
      setStatus({ state: 'synced', message: 'Synchronisiert', lastSync: Date.now(), counts });
    } catch (err) {
      setStatus({ state: 'error', message: err.message || 'Sync-Fehler – arbeitet lokal weiter' });
    }
  }
};
