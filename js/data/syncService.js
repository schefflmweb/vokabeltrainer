import { authService } from '../auth/authService.js';
import { vocabStore } from './vocabStore.js';
import { db } from './db.js';

const GRAPH_FILE_URL = 'https://graph.microsoft.com/v1.0/me/drive/special/approot:/vocab-data.json:/content';

let listeners = [];
let status = { state: 'offline', message: 'Nur lokal gespeichert', lastSync: null };

function setStatus(next) {
  status = { ...status, ...next };
  listeners.forEach((fn) => fn(status));
}

async function fetchRemote(token) {
  const res = await fetch(GRAPH_FILE_URL, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (res.status === 404) return { records: null, etag: null };
  if (!res.ok) throw new Error(`OneDrive-Abruf fehlgeschlagen (${res.status})`);
  const etag = res.headers.get('ETag');
  const body = await res.json();
  return { records: body.vocab || [], etag };
}

async function pushRemote(token, records, etag) {
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json'
  };
  if (etag) headers['If-Match'] = etag;
  const res = await fetch(GRAPH_FILE_URL, {
    method: 'PUT',
    headers,
    body: JSON.stringify({ vocab: records, savedAt: new Date().toISOString() })
  });
  return res;
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

  async sync() {
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
      let { records: remoteRecords, etag } = await fetchRemote(token);
      const merged = await vocabStore.mergeFromRemote(remoteRecords);

      let res = await pushRemote(token, merged, etag);
      if (res.status === 412) {
        // Someone else wrote in the meantime — re-pull, re-merge, retry once.
        const retryRemote = await fetchRemote(token);
        const remerged = await vocabStore.mergeFromRemote(retryRemote.records);
        res = await pushRemote(token, remerged, retryRemote.etag);
      }
      if (!res.ok) throw new Error(`OneDrive-Speichern fehlgeschlagen (${res.status})`);

      const dirty = await vocabStore.getDirty();
      await vocabStore.clearDirty(dirty.map((d) => d.id));
      await db.setMeta('lastSync', Date.now());

      setStatus({ state: 'synced', message: 'Synchronisiert', lastSync: Date.now() });
    } catch (err) {
      setStatus({ state: 'error', message: err.message || 'Sync-Fehler – arbeitet lokal weiter' });
    }
  }
};
