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
 * ~1MB); byte-accurate chunks targeting 800KB, then 200KB, both still got
 * truncated in practice. Gone much smaller here — cheap, since smaller
 * files cost nothing but a few more of them in the gist.
 */
const MAX_FILE_BYTES = 50 * 1024;

/**
 * Also caps how many bytes go into a single PATCH request, splitting into
 * several requests if needed — in case it's not really any one file's size
 * that matters but the total size of one write, which sending many chunks
 * in a single request would still hit even with small individual files.
 */
const MAX_PATCH_BYTES = 150 * 1024;

/**
 * A truncation error on a real device's gist reported the exact cutoff
 * point: content stopped after 921600 bytes cumulative across the gist's
 * files, in listing order — 900 * 1024, suspiciously exact. That lines up
 * with everything observed: per-file size never mattered (files well under
 * every target tried, including one already under 50KB, still got cut),
 * only the running total across ALL of a gist's files did, with whichever
 * file straddled that point coming back truncated mid-content. So instead
 * of chasing per-file size, the data is now split across as many separate
 * gists as needed, each kept safely under this — comfortably below 900KiB,
 * leaving real margin instead of grazing the edge again as the vocab list
 * grows further.
 */
const MAX_GIST_BYTES = 600 * 1024;

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

async function createGistShard(token, filesPayload) {
  const res = await fetchWithRetry(`${API_BASE}/gists`, {
    method: 'POST',
    headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ description: GIST_DESCRIPTION, public: false, files: filesPayload })
  });
  if (!res.ok) throw new Error(httpErrorMessage(res, 'Gist anlegen fehlgeschlagen'));
  const created = await res.json();
  return created.id;
}

/**
 * A 404 right after creating a gist (or right after writing to one, for
 * pushGistFiles's own verification read) can be GitHub's read path not yet
 * reflecting a write that only just happened, not the gist actually being
 * gone — so a lone immediate 404 is retried a couple of times with a short
 * delay before it's treated as real.
 */
const GIST_404_RETRY_DELAYS_MS = [700, 1500, 2500, 4000];

async function fetchGistFiles(token, gistId, attempt = 0) {
  const res = await fetchWithRetry(`${API_BASE}/gists/${gistId}`, { headers: authHeaders(token) });
  if (res.status === 404) {
    if (attempt < GIST_404_RETRY_DELAYS_MS.length) {
      await new Promise((r) => setTimeout(r, GIST_404_RETRY_DELAYS_MS[attempt]));
      return fetchGistFiles(token, gistId, attempt + 1);
    }
    throw new Error('Gist nicht gefunden — bitte erneut synchronisieren');
  }
  if (!res.ok) throw new Error(httpErrorMessage(res, 'GitHub-Abruf fehlgeschlagen'));
  const gist = await res.json();
  return gist.files || {};
}

/**
 * The data now lives across however many gists (all sharing the same
 * description) are needed to stay under MAX_GIST_BYTES each — reads every
 * one and keeps track of which files came from which gist, so a later write
 * can tell which stale filenames to clear out of which specific shard.
 */
async function fetchAllShardFiles(token, gistIds) {
  const shardFiles = new Map();
  for (const gistId of gistIds) {
    shardFiles.set(gistId, await fetchGistFiles(token, gistId));
  }
  const merged = {};
  for (const filesObj of shardFiles.values()) Object.assign(merged, filesObj);
  return { shardFiles, merged };
}

/** Packs a full files payload into batches that each stay under MAX_GIST_BYTES — one batch per gist shard. Always at least one batch, even if empty, so a shard exists for a brand-new sync. */
function distributeIntoShards(filesPayload) {
  const entries = Object.entries(filesPayload).filter(([, val]) => val);
  const shards = [];
  let current = {};
  let currentBytes = 0;
  for (const [name, val] of entries) {
    const bytes = utf8ByteLength(val.content);
    if (Object.keys(current).length > 0 && currentBytes + bytes > MAX_GIST_BYTES) {
      shards.push(current);
      current = {};
      currentBytes = 0;
    }
    current[name] = val;
    currentBytes += bytes;
  }
  if (Object.keys(current).length > 0 || shards.length === 0) shards.push(current);
  return shards;
}

/**
 * Writes the full files payload across shard gists: reuses existing shard
 * ids in order (clearing out any filename that used to live in that shard
 * but isn't part of its new batch — e.g. because chunk boundaries shifted
 * and it now belongs to a different shard), creates new shard gists if the
 * data grew past what the existing ones can hold, and deletes any shard
 * gists left over if it shrank.
 */
async function pushShardedGistFiles(token, gistIds, shardFilesBefore, filesPayload) {
  const shardBatches = distributeIntoShards(filesPayload);
  const resultGistIds = [];
  for (let i = 0; i < shardBatches.length; i++) {
    const batch = { ...shardBatches[i] };
    if (i < gistIds.length) {
      const gistId = gistIds[i];
      const previousNames = Object.keys(shardFilesBefore.get(gistId) || {});
      for (const name of previousNames) {
        if (!(name in batch)) batch[name] = null;
      }
      await pushGistFiles(token, gistId, batch);
      resultGistIds.push(gistId);
    } else {
      resultGistIds.push(await createGistShard(token, batch));
    }
  }
  for (let i = shardBatches.length; i < gistIds.length; i++) {
    const res = await fetchWithRetry(`${API_BASE}/gists/${gistIds[i]}`, { method: 'DELETE', headers: authHeaders(token) });
    if (!res.ok && res.status !== 404) throw new Error(httpErrorMessage(res, 'Aufräumen fehlgeschlagen'));
  }
  return resultGistIds;
}

const VERIFY_TRUNCATION_DELAYS_MS = [2000, 2000, 3000];

async function pushGistFilesOnce(token, gistId, batchPayload) {
  const res = await fetchWithRetry(`${API_BASE}/gists/${gistId}`, {
    method: 'PATCH',
    headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ files: batchPayload })
  });
  if (!res.ok) throw new Error(httpErrorMessage(res, 'GitHub-Speichern fehlgeschlagen'));
}

/**
 * Pushes files — split across several smaller PATCH requests if the total
 * would exceed MAX_PATCH_BYTES — then does a genuine, separate GET to
 * verify none of them come back truncated.
 *
 * A file reported truncated at just ~51KB (barely over the 50KB target,
 * itself already shrunk down from 800KB→200KB in earlier attempts that
 * didn't help either) ruled out file/request size as the actual cause.
 * What's stayed consistent across every attempt is firing several PATCH
 * requests at the same gist back-to-back with no gap between them — so the
 * working theory now is that GitHub's backend needs a moment to fully
 * settle one write to a gist before the next one lands cleanly, and without
 * that gap a later write in the sequence (consistently the ~9th-10th
 * request) can come out corrupted/truncated. Each batch now waits before
 * the next one is sent.
 *
 * Separately, the PATCH response's own echoed file list turned out not to
 * reflect real truncation (a file could look fine right in a PATCH response
 * and still show up truncated on the very next plain read), so only an
 * actual follow-up GET can be trusted — and even that isn't necessarily
 * final right away, the same kind of lag that makes a GET 404 right after a
 * gist is created can, it seems, also affect whether GitHub has finished
 * deciding a just-written file needs to be truncated. So this waits before
 * checking, and if it does find something truncated, waits and checks again
 * a few times before concluding it's real — favoring a slower sync over a
 * false alarm.
 */
const BETWEEN_BATCH_DELAY_MS = 1200;

async function pushGistFiles(token, gistId, filesPayload) {
  const entries = Object.entries(filesPayload);
  let batch = {};
  let batchBytes = 0;
  let batchesSent = 0;
  for (const [name, val] of entries) {
    const entryBytes = val ? utf8ByteLength(val.content) : 0;
    if (Object.keys(batch).length > 0 && batchBytes + entryBytes > MAX_PATCH_BYTES) {
      if (batchesSent > 0) await new Promise((r) => setTimeout(r, BETWEEN_BATCH_DELAY_MS));
      await pushGistFilesOnce(token, gistId, batch);
      batchesSent++;
      batch = {};
      batchBytes = 0;
    }
    batch[name] = val;
    batchBytes += entryBytes;
  }
  if (Object.keys(batch).length > 0) {
    if (batchesSent > 0) await new Promise((r) => setTimeout(r, BETWEEN_BATCH_DELAY_MS));
    await pushGistFilesOnce(token, gistId, batch);
  }

  let truncated = [];
  let lastVerifyFiles = {};
  for (let attempt = 0; attempt <= VERIFY_TRUNCATION_DELAYS_MS.length; attempt++) {
    await new Promise((r) => setTimeout(r, attempt === 0 ? 1500 : VERIFY_TRUNCATION_DELAYS_MS[attempt - 1]));
    lastVerifyFiles = await fetchGistFiles(token, gistId);
    truncated = Object.entries(lastVerifyFiles).filter(([, file]) => file.truncated);
    if (truncated.length === 0) break;
  }
  if (truncated.length > 0) {
    // A per-file size limit alone stopped explaining the pattern once a file
    // reported truncated (51091 bytes) that was already *under* the 50KB
    // target — so this now also reports the running total across every file
    // in the gist, in the same order the API lists them, to check whether
    // it's really the combined size of the whole gist that matters instead.
    let cumulative = 0;
    const withOffsets = Object.entries(lastVerifyFiles).map(([name, file]) => {
      const bytes = file.size ?? (file.content ? utf8ByteLength(file.content) : 0);
      const startOffset = cumulative;
      cumulative += bytes;
      return { name, file, bytes, startOffset, endOffset: cumulative };
    });
    const totalGistBytes = cumulative;
    const details = truncated.map(([name]) => {
      const info = withOffsets.find((f) => f.name === name);
      const receivedBytes = info.file.content ? utf8ByteLength(info.file.content) : 0;
      return `${name} (${info.bytes} Bytes gemeldet, ${receivedBytes} Bytes tatsächlich erhalten, kumulativ ${info.startOffset}-${info.endOffset} von insgesamt ${totalGistBytes} Bytes im gesamten Gist)`;
    }).join('; ');
    throw new Error(`GitHub hat beim Hochladen ${details} trotzdem gekürzt — bitte "Sync zurücksetzen" versuchen. Damit merkt dieses Gerät es sofort, statt dass es erst später auf einem anderen auffällt.`);
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

/**
 * Finds the single largest record by serialized size, if any is suspiciously
 * large. Truncation kept recurring on a different file across several
 * rounds of shrinking the target file size and even splitting writes into
 * smaller requests — which points away from an even distribution of normal-
 * sized records and toward one (or a few) outliers, e.g. a record corrupted
 * during one of many import/merge cycles, single-handedly blowing up
 * whatever chunk it lands in regardless of how conservative the target is.
 */
function findOversizedRecord(records, thresholdBytes = 5000) {
  let worst = null;
  for (const record of records) {
    const size = utf8ByteLength(JSON.stringify(record));
    if (size > thresholdBytes && (!worst || size > worst.size)) worst = { size, record };
  }
  return worst;
}

/**
 * Builds the file content with one record per line rather than
 * JSON.stringify()'s single unbroken line — still valid JSON, since
 * whitespace between tokens is ignored by JSON.parse().
 */
function formatChunkContent(field, chunk, savedAt) {
  const items = chunk.map((record) => JSON.stringify(record)).join(',\n');
  return `{"${field}":[\n${items}\n],"savedAt":${JSON.stringify(savedAt)}}`;
}

/**
 * Splits `records` into chunks that each stay under MAX_FILE_BYTES —
 * always at least one chunk, even if empty, so the base file always exists.
 *
 * Every truncation report named a file just barely over the 50KB target
 * (e.g. 51299 bytes for a 51200-byte target), on a different file each time,
 * no matter how much else changed (request delay, PATCH batching, line
 * format) — because none of those touched the actual bug: this used to
 * budget each chunk against a made-up 2-byte overhead ("[" + "]") and a
 * 1-byte-per-record separator, while the real wrapper written by
 * formatChunkContent() is `{"field":[\n...\n],"savedAt":"..."}` (tens of
 * bytes) joined with ',\n' (2 bytes, not 1) — so every chunk packed right up
 * to the budget came out some tens of bytes larger than MAX_FILE_BYTES once
 * actually formatted, consistently spilling just past GitHub's real
 * truncation threshold. Packing now measures the real formatted output size
 * instead of approximating it.
 */
function chunkRecords(records, field, savedAt) {
  const overhead = utf8ByteLength(formatChunkContent(field, [], savedAt));
  const chunks = [];
  let current = [];
  let currentSize = overhead;
  for (const record of records) {
    const recordBytes = utf8ByteLength(JSON.stringify(record));
    const separatorBytes = current.length > 0 ? 2 : 0; // ',\n' before every item but the first
    const addedSize = recordBytes + separatorBytes;
    if (current.length > 0 && currentSize + addedSize > MAX_FILE_BYTES) {
      chunks.push(current);
      current = [];
      currentSize = overhead;
    }
    current.push(record);
    currentSize += current.length > 1 ? addedSize : recordBytes;
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
      // See the matching diagnostic in pushGistFiles(): also reports where
      // this file sits in the gist's running byte total, to help tell a
      // per-file limit apart from a whole-gist one.
      let cumulative = 0;
      let startOffset = 0;
      for (const [otherName, otherFile] of Object.entries(files)) {
        const bytes = otherFile.size ?? (otherFile.content ? utf8ByteLength(otherFile.content) : 0);
        if (otherName === name) startOffset = cumulative;
        cumulative += bytes;
      }
      const receivedBytes = file.content ? utf8ByteLength(file.content) : 0;
      throw new Error(`GitHub hat "${name}" (${file.size ?? '?'} Bytes gemeldet, ${receivedBytes} Bytes tatsächlich erhalten, kumulativ ab ${startOffset} von insgesamt ${cumulative} Bytes im gesamten Datenbestand) beim Lesen gekürzt — Sync abgebrochen, um keine Daten zu verlieren. Ein normaler Sync liest diesen alten, kaputten Stand immer wieder — bitte auf DIESEM Gerät (falls die Vokabeln hier vollständig/aktuell sind) den Button "Sync zurücksetzen" verwenden statt erneut "Jetzt synchronisieren", das baut den Gist komplett neu auf.`);
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
   * Deletes every remote gist shard (if any exist) and lets the next sync
   * create fresh ones from scratch — the escape hatch for a shard stuck in
   * a state no sync can read past (e.g. a truncated file from before this
   * app version), since every sync must successfully read before it can
   * write, so a broken remote otherwise blocks every device equally,
   * including the one with complete, correct local data. Only ever run this
   * on the device whose local data is actually complete/current — it
   * becomes the new source of truth for the fresh gist(s).
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
      // Delete every gist matching our description, however many shards
      // that turns out to be — repeated resets, races between devices, or
      // a data set that once needed more shards than it does now can all
      // leave extras lying around.
      const ids = await findAllMatchingGistIds(token);
      for (const id of ids) {
        const res = await fetchWithRetry(`${API_BASE}/gists/${id}`, { method: 'DELETE', headers: authHeaders(token) });
        if (!res.ok && res.status !== 404) throw new Error(httpErrorMessage(res, 'Zurücksetzen fehlgeschlagen'));
      }
      // Hand _runSync an empty shard list directly instead of letting it
      // look them up again — nothing to find right after deleting them all.
      return this._runSync([]);
    } catch (err) {
      setStatus({ state: 'error', message: err.message || 'Zurücksetzen fehlgeschlagen' });
    }
  },

  /** knownGistIds lets resetRemote() skip the lookup right after deleting everything — omitted for a normal sync(), which always looks up the current shards fresh. */
  async _runSync(knownGistIds) {
    await githubAuth.ready();
    const token = githubAuth.getToken();
    if (!token) {
      setStatus({ state: 'signed-out', message: 'Nicht verbunden – arbeitet lokal weiter' });
      return;
    }

    setStatus({ state: 'syncing', message: 'Synchronisiere …' });
    try {
      const gistIds = knownGistIds !== undefined ? knownGistIds : await findAllMatchingGistIds(token);
      const { shardFiles, merged: files } = gistIds.length > 0
        ? await fetchAllShardFiles(token, gistIds)
        : { shardFiles: new Map(), merged: {} };

      const pushPayload = {};
      const counts = {};
      for (const { store, baseFileName, field } of COLLECTIONS) {
        const remoteRecords = collectRemoteRecords(files, baseFileName, field);
        const merged = await store.mergeFromRemote(remoteRecords);
        // Tombstones (deleted: true) stay in the merged/pushed set so the
        // deletion itself propagates, but they're not real entries — don't
        // count them for the "how many are actually on the gist" display.
        counts[field] = merged.filter((r) => !r.deleted).length;
        const oversized = findOversizedRecord(merged);
        if (oversized) {
          const preview = (oversized.record.en || oversized.record.question || oversized.record.id || '').toString().slice(0, 60);
          throw new Error(`Ein einzelner Eintrag in "${field}" ist auffällig groß (${Math.round(oversized.size / 1024)} KB — normal wären wenige hundert Bytes): "${preview}…". Das ist vermutlich die eigentliche Ursache der Kürzungs-Fehler. Bitte in Verwalten danach suchen und den Eintrag bearbeiten oder löschen.`);
        }
        const savedAt = new Date().toISOString();
        const chunks = chunkRecords(merged, field, savedAt);
        chunks.forEach((chunk, i) => {
          pushPayload[partFileName(baseFileName, i)] = { content: formatChunkContent(field, chunk, savedAt) };
        });
      }
      // pushShardedGistFiles clears any filename that no longer appears in
      // pushPayload out of whichever shard it used to live in, so there's
      // no separate "drop leftover files" pass needed here.
      await pushShardedGistFiles(token, gistIds, shardFiles, pushPayload);

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
