import { authService } from '../auth/authService.js';
import { vocabStore } from './vocabStore.js';
import { grammarStore } from './grammarStore.js';
import { db } from './db.js';

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0/me/drive/special/approot:/';

/** Each collection gets its own file in the OneDrive app folder, synced independently but as part of the same sync() pass. */
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

async function fetchRemote(token, fileName, field) {
  const res = await fetch(`${GRAPH_BASE}${fileName}:/content`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (res.status === 404) return { records: null, etag: null };
  if (!res.ok) throw new Error(`OneDrive-Abruf fehlgeschlagen (${res.status})`);
  const etag = res.headers.get('ETag');
  const body = await res.json();
  return { records: body[field] || [], etag };
}

async function pushRemote(token, fileName, field, records, etag) {
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json'
  };
  if (etag) headers['If-Match'] = etag;
  const res = await fetch(`${GRAPH_BASE}${fileName}:/content`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({ [field]: records, savedAt: new Date().toISOString() })
  });
  return res;
}

/** Pull → merge → push for one collection, with a single retry if someone else wrote in the meantime (412). */
async function syncCollection(token, { store, fileName, field }) {
  let { records: remoteRecords, etag } = await fetchRemote(token, fileName, field);
  const merged = await store.mergeFromRemote(remoteRecords);

  let res = await pushRemote(token, fileName, field, merged, etag);
  if (res.status === 412) {
    const retryRemote = await fetchRemote(token, fileName, field);
    const remerged = await store.mergeFromRemote(retryRemote.records);
    res = await pushRemote(token, fileName, field, remerged, retryRemote.etag);
  }
  if (!res.ok) throw new Error(`OneDrive-Speichern fehlgeschlagen (${res.status})`);

  const dirty = await store.getDirty();
  await store.clearDirty(dirty.map((d) => d.id));
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

  /** Runs a sync now. Concurrent calls join the same in-flight run instead of firing overlapping full-collection uploads. */
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
   * last request instead of doing a full upload/download of the whole
   * collection per review.
   */
  scheduleSync() {
    clearTimeout(scheduleTimer);
    scheduleTimer = setTimeout(() => this.sync(), SCHEDULE_DEBOUNCE_MS);
  },

  async _runSync() {
    if (!authService.isConfigured()) {
      setStatus({ state: 'offline', message: 'OneDrive-Sync noch nicht eingerichtet' });
      return;
    }
    const token = await authService.acquireToken();
    if (!token) {
      setStatus({ state: 'signed-out', message: 'Nicht angemeldet – arbeitet lokal weiter' });
      return;
    }

    setStatus({ state: 'syncing', message: 'Synchronisiere …' });
    try {
      for (const collection of COLLECTIONS) {
        await syncCollection(token, collection);
      }
      await db.setMeta('lastSync', Date.now());
      setStatus({ state: 'synced', message: 'Synchronisiert', lastSync: Date.now() });
    } catch (err) {
      setStatus({ state: 'error', message: err.message || 'Sync-Fehler – arbeitet lokal weiter' });
    }
  }
};
