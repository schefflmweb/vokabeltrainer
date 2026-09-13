import { getFirebase } from './firebaseClient.js';
import { firebaseAuth } from '../auth/firebaseAuth.js';
import { vocabStore } from './vocabStore.js';
import { grammarStore } from './grammarStore.js';
import { idiomStore } from './idiomStore.js';
import { db } from './db.js';

/**
 * Each collection's records are stored as individual Firestore documents
 * (one per vocab/grammar entry, keyed by the record's own id) rather than
 * the old GitHub Gist's JSON-blob files. That whole earlier design — byte-
 * accurate chunking, splitting writes across multiple gists, retry/settling
 * delays — existed only to work around GitHub's undocumented ~900KiB
 * combined-file-size-per-gist limit; a real per-record database has no
 * equivalent problem (Firestore's own per-document cap is 1MiB, thousands
 * of times more than any single vocab record needs), so none of that is
 * needed here.
 */
const COLLECTIONS = [
  { store: vocabStore, collectionName: 'vocab', field: 'vocab' },
  { store: grammarStore, collectionName: 'grammar', field: 'grammar' },
  { store: idiomStore, collectionName: 'idioms', field: 'idioms' }
];

/**
 * Each collection's pull query only fetches documents changed since the
 * last pull (`updatedAt > cursor`) instead of re-reading the whole
 * collection every sync — cheap and keeps well within Firestore's free-tier
 * daily read quota even with frequent syncs. The cursor is rewound by this
 * much before each query as a clock-skew safety margin: `updatedAt` is a
 * plain client-set timestamp (not a Firestore server timestamp), so two
 * devices' clocks won't agree exactly — without a buffer, a record written
 * right around the previous cursor could be silently skipped forever.
 * Re-fetching a handful of already-seen records is cheap; missing a real
 * update isn't.
 */
const PULL_BUFFER_MS = 2 * 60 * 1000;

/** Firestore caps a single batch write at 500 operations — stay comfortably under that so a large CSV import just becomes a couple of batches instead of one that fails outright. */
const BATCH_WRITE_LIMIT = 450;

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

/** Turns a Firestore error into a message that actually helps for the causes most likely to happen here. */
function firestoreErrorMessage(err) {
  const code = err?.code || '';
  if (code === 'permission-denied') {
    return 'Zugriff verweigert — bitte in Firebase prüfen, ob die Firestore-Regeln korrekt auf deine UID gesetzt sind.';
  }
  if (code === 'unavailable' || code === 'failed-precondition' || code === 'deadline-exceeded') {
    return 'Keine Verbindung zu Firebase möglich — bitte kurz erneut versuchen.';
  }
  return err?.message || 'Sync-Fehler – arbeitet lokal weiter';
}

/** `dirty` is purely local sync-tracking, not part of the record itself — stripped before writing to Firestore. */
function sanitizeForFirestore(record) {
  const { dirty, ...rest } = record;
  return rest;
}

async function pullCollection(dbFns, firestoreDb, collectionName, cursorKey) {
  const since = (await db.getMeta(cursorKey)) || 0;
  const sinceBuffered = Math.max(0, since - PULL_BUFFER_MS);
  const pullStartedAt = Date.now();
  const q = dbFns.query(dbFns.collection(firestoreDb, collectionName), dbFns.where('updatedAt', '>', sinceBuffered));
  const snapshot = await dbFns.getDocs(q);
  return { records: snapshot.docs.map((d) => d.data()), pullStartedAt };
}

async function pushCollection(dbFns, firestoreDb, collectionName, records) {
  for (let i = 0; i < records.length; i += BATCH_WRITE_LIMIT) {
    const slice = records.slice(i, i + BATCH_WRITE_LIMIT);
    const batch = dbFns.writeBatch(firestoreDb);
    for (const record of slice) {
      batch.set(dbFns.doc(firestoreDb, collectionName, record.id), sanitizeForFirestore(record));
    }
    await batch.commit();
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

  /**
   * Resets this device's local "synced up to here" bookmark for every
   * collection and re-pulls everything from Firestore from scratch. Purely
   * local and safe — unlike the old GitHub-Gist-era "Sync zurücksetzen",
   * nothing in Firestore is deleted or overwritten, only this device's own
   * cursor is rewound.
   *
   * Exists because the incremental pull's cursor always advances to "now"
   * after a pull completes, regardless of whether that specific pull
   * actually captured every matching record a fully correct query would
   * have. If any one pull is ever incomplete for any reason (a transient
   * network hiccup, the tab being suspended mid-fetch, or anything else
   * that lets the call resolve without throwing but with fewer documents
   * than truly exist), the records it missed fall below that device's
   * cursor and are silently, permanently excluded from every later
   * incremental sync on that specific device — even though they were never
   * actually lost from Firestore, just no longer reachable by this
   * device's own incremental query.
   */
  fullResync() {
    if (syncPromise) return syncPromise.then(() => this.fullResync());
    syncPromise = this._runFullResync().finally(() => {
      syncPromise = null;
    });
    return syncPromise;
  },

  async _runFullResync() {
    for (const { collectionName } of COLLECTIONS) {
      await db.setMeta(`firestoreCursor_${collectionName}`, 0);
    }
    return this._runSync();
  },

  async _runSync() {
    await firebaseAuth.ready();
    if (!firebaseAuth.isConfigured()) {
      setStatus({ state: 'signed-out', message: 'Nicht verbunden – arbeitet lokal weiter' });
      return;
    }

    setStatus({ state: 'syncing', message: 'Synchronisiere …' });
    try {
      const { db: firestoreDb, dbFns } = await getFirebase();

      const counts = {};
      for (const { store, collectionName, field } of COLLECTIONS) {
        const cursorKey = `firestoreCursor_${collectionName}`;
        const { records: remoteRecords, pullStartedAt } = await pullCollection(dbFns, firestoreDb, collectionName, cursorKey);
        const merged = await store.mergeFromRemote(remoteRecords);
        // Tombstones (deleted: true) stay in the merged/pushed set so the
        // deletion itself propagates, but they're not real entries — don't
        // count them for the "how many are actually in the cloud" display.
        counts[field] = merged.filter((r) => !r.deleted).length;

        const dirty = await store.getDirty();
        if (dirty.length > 0) {
          await pushCollection(dbFns, firestoreDb, collectionName, dirty);
          await store.clearDirty(dirty.map((d) => d.id));
        }

        await db.setMeta(cursorKey, pullStartedAt);
      }

      await Promise.all([db.setMeta('lastSync', Date.now()), db.setMeta('lastSyncCounts', counts)]);
      setStatus({ state: 'synced', message: 'Synchronisiert', lastSync: Date.now(), counts });
    } catch (err) {
      setStatus({ state: 'error', message: firestoreErrorMessage(err) });
    }
  }
};
