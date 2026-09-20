import { getFirebase } from './firebaseClient.js';
import { firebaseAuth } from '../auth/firebaseAuth.js';
import { vocabStore } from './vocabStore.js';
import { grammarStore } from './grammarStore.js';
import { idiomStore } from './idiomStore.js';
import { deletionQueue } from './deletionQueue.js';
import { deviceRole } from './deviceRole.js';
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
 *
 * The sync is deliberately asymmetric (see deviceRole.js): master data flows
 * PC -> cloud -> phones, learning progress flows both ways.
 *
 *   master device  full push: new/edited records, deletions, wipes.
 *   reader device  pulls everything; pushes nothing but the `srs` field of
 *                  records it has actually seen in the cloud, merged into
 *                  the existing document so it can't overwrite a word, its
 *                  translation or its category with a stale local copy.
 */
const COLLECTIONS = [
  { store: vocabStore, collectionName: 'vocab', field: 'vocab' },
  { store: grammarStore, collectionName: 'grammar', field: 'grammar' },
  { store: idiomStore, collectionName: 'idioms', field: 'idioms' }
];

/**
 * A hard delete leaves nothing behind to sync — the record is simply gone
 * from IndexedDB and from its Firestore collection, so a device that was
 * offline at the time would never learn about it and would happily re-upload
 * its own copy. These two little side-channels carry the deletions instead:
 *
 *   deletions/<collection>__<id>  one marker per deleted record,
 *                                 { collection, recordId, deletedAt }.
 *   control/wipe                  one timestamp per collection, for
 *                                 "alles löschen" — 18.000 markers to say
 *                                 "everything is gone" would cost far more
 *                                 than the deletion itself.
 */
const DELETIONS_COLLECTION = 'deletions';
const CONTROL_COLLECTION = 'control';
const WIPE_DOC = 'wipe';

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

/**
 * Bumped when the local bookkeeping a sync relies on changes shape. v2
 * introduced `fromCloud` (which records a reader is allowed to push progress
 * for) and real deletes; both need one full pull to be established on a
 * device that has been syncing incrementally until now, so the migration
 * rewinds every cursor once and drops the leftover tombstones.
 */
const SYNC_SCHEMA_VERSION = 2;

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
  if (code === 'resource-exhausted') {
    return 'Tageslimit von Firebase erreicht (kostenlose Stufe: 50.000 Lesevorgänge/Tag) — bitte bis Mitternacht Pazifik-Zeit warten oder in der Firebase-Konsole auf den Blaze-Tarif upgraden. Vokabeln sind dadurch nicht verloren, nur der Sync pausiert bis dahin.';
  }
  return err?.message || 'Sync-Fehler – arbeitet lokal weiter';
}

/** `dirty` and `fromCloud` are purely local sync bookkeeping, not part of the record itself — stripped before writing to Firestore. */
function sanitizeForFirestore(record) {
  const { dirty, fromCloud, ...rest } = record;
  return rest;
}

/** Runs `write(batch, item)` over every item, committing every BATCH_WRITE_LIMIT operations. */
async function inBatches(dbFns, firestoreDb, items, write) {
  for (let i = 0; i < items.length; i += BATCH_WRITE_LIMIT) {
    const batch = dbFns.writeBatch(firestoreDb);
    for (const item of items.slice(i, i + BATCH_WRITE_LIMIT)) write(batch, item);
    await batch.commit();
  }
}

async function pullCollection(dbFns, firestoreDb, collectionName, cursorKey) {
  const since = (await db.getMeta(cursorKey)) || 0;
  const sinceBuffered = Math.max(0, since - PULL_BUFFER_MS);
  const pullStartedAt = Date.now();
  const q = dbFns.query(dbFns.collection(firestoreDb, collectionName), dbFns.where('updatedAt', '>', sinceBuffered));
  const snapshot = await dbFns.getDocs(q);
  return { records: snapshot.docs.map((d) => d.data()), pullStartedAt };
}

/** Full records — master devices only. */
async function pushRecords(dbFns, firestoreDb, collectionName, records) {
  await inBatches(dbFns, firestoreDb, records, (batch, record) => {
    batch.set(dbFns.doc(firestoreDb, collectionName, record.id), sanitizeForFirestore(record));
  });
}

/**
 * Learning progress only — reader devices. A merged write of just `srs` and
 * `updatedAt` touches nothing else in the document, so a phone that still
 * holds last week's spelling of a word can't push it back over the PC's
 * correction. Only records the cloud actually has are offered to this
 * function: a merge write to a missing document would recreate it, which is
 * exactly what a reader must never do.
 */
async function pushProgress(dbFns, firestoreDb, collectionName, records) {
  await inBatches(dbFns, firestoreDb, records, (batch, record) => {
    batch.set(
      dbFns.doc(firestoreDb, collectionName, record.id),
      { srs: record.srs, updatedAt: record.updatedAt },
      { merge: true }
    );
  });
}

/** Removes documents by id and leaves a deletion marker for each, so devices that are offline right now still learn about it. */
async function pushDeletions(dbFns, firestoreDb, collectionName, ids, deletedAt) {
  await inBatches(dbFns, firestoreDb, ids, (batch, id) => {
    batch.delete(dbFns.doc(firestoreDb, collectionName, id));
    batch.set(dbFns.doc(firestoreDb, DELETIONS_COLLECTION, `${collectionName}__${id}`), {
      collection: collectionName,
      recordId: id,
      deletedAt
    });
  });
}

/** Deletes every document of one collection plus its deletion markers, then publishes the wipe timestamp. Used by "alles löschen" on the master device. */
async function wipeCloudCollection(dbFns, firestoreDb, collectionName, wipedAt) {
  const snapshot = await dbFns.getDocs(dbFns.collection(firestoreDb, collectionName));
  await inBatches(dbFns, firestoreDb, snapshot.docs, (batch, d) => batch.delete(d.ref));

  // Per-record markers for this collection are pointless once everything is
  // gone — the wipe marker says the same thing in one document.
  const markers = await dbFns.getDocs(
    dbFns.query(dbFns.collection(firestoreDb, DELETIONS_COLLECTION), dbFns.where('collection', '==', collectionName))
  );
  await inBatches(dbFns, firestoreDb, markers.docs, (batch, d) => batch.delete(d.ref));

  await dbFns.setDoc(dbFns.doc(firestoreDb, CONTROL_COLLECTION, WIPE_DOC), { [collectionName]: wipedAt }, { merge: true });
}

async function readWipeMarkers(dbFns, firestoreDb) {
  const snapshot = await dbFns.getDoc(dbFns.doc(firestoreDb, CONTROL_COLLECTION, WIPE_DOC));
  return snapshot.exists() ? snapshot.data() : {};
}

/** Pulls deletion markers written since the last sync and groups the ids by collection. */
async function pullDeletions(dbFns, firestoreDb) {
  const since = (await db.getMeta('firestoreCursor_deletions')) || 0;
  const sinceBuffered = Math.max(0, since - PULL_BUFFER_MS);
  const pullStartedAt = Date.now();
  const q = dbFns.query(
    dbFns.collection(firestoreDb, DELETIONS_COLLECTION),
    dbFns.where('deletedAt', '>', sinceBuffered)
  );
  const snapshot = await dbFns.getDocs(q);
  const byCollection = {};
  for (const d of snapshot.docs) {
    const { collection, recordId } = d.data();
    if (!collection || !recordId) continue;
    if (!byCollection[collection]) byCollection[collection] = [];
    byCollection[collection].push(recordId);
  }
  return { byCollection, pullStartedAt };
}

async function rewindCursors() {
  for (const { collectionName } of COLLECTIONS) {
    await db.setMeta(`firestoreCursor_${collectionName}`, 0);
  }
  await db.setMeta('firestoreCursor_deletions', 0);
}

/** One-time upgrade of this device's local sync bookkeeping — see SYNC_SCHEMA_VERSION. */
async function migrateIfNeeded() {
  const version = (await db.getMeta('syncSchemaVersion')) || 1;
  if (version >= SYNC_SCHEMA_VERSION) return;
  for (const { store } of COLLECTIONS) await store.purgeTombstones();
  await rewindCursors();
  await db.setMeta('syncSchemaVersion', SYNC_SCHEMA_VERSION);
}

/** Empties the local store when another device wiped that collection in the cloud after this device last applied a wipe. */
async function applyRemoteWipe(store, collectionName, wipedAt) {
  if (!wipedAt) return;
  const appliedKey = `lastWipeApplied_${collectionName}`;
  if (wipedAt <= ((await db.getMeta(appliedKey)) || 0)) return;
  await store.clearLocal();
  await db.setMeta(appliedKey, wipedAt);
  // Everything that was ever pulled is gone; the next pull has to start from
  // scratch or it would only ever see records written after the wipe.
  await db.setMeta(`firestoreCursor_${collectionName}`, 0);
}

/** Carries out a locally queued "alles löschen" in the cloud. Runs before the pull, so the records about to be deleted aren't fetched first. */
async function pushLocalWipe(dbFns, firestoreDb, collectionName) {
  const wipedAt = await deletionQueue.pendingWipe(collectionName);
  if (!wipedAt) return;
  await wipeCloudCollection(dbFns, firestoreDb, collectionName, wipedAt);
  await deletionQueue.clearWipe(collectionName);
  await db.setMeta(`lastWipeApplied_${collectionName}`, wipedAt);
  await db.setMeta(`firestoreCursor_${collectionName}`, 0);
}

async function pushMaster(dbFns, firestoreDb, store, collectionName, tombstoneIds) {
  const queued = await deletionQueue.pendingDeletes(collectionName);
  // Tombstones are documents from before deletes became real: the record is
  // already gone from every device that merged them, but the document
  // lingers in Firestore. The master clears those out for good, with a
  // marker so devices that haven't pulled the tombstone yet still follow.
  const toDelete = [...new Set([...queued, ...(tombstoneIds || [])])];
  if (toDelete.length > 0) {
    await pushDeletions(dbFns, firestoreDb, collectionName, toDelete, Date.now());
    await deletionQueue.clearDeletes(collectionName, toDelete);
  }

  const dirty = await store.getDirty();
  if (dirty.length > 0) {
    await pushRecords(dbFns, firestoreDb, collectionName, dirty);
    await store.clearDirty(dirty.map((d) => d.id));
  }
}

async function pushReader(dbFns, firestoreDb, store, collectionName) {
  // A reader never deletes anything in the cloud. A delete that somehow got
  // queued here (e.g. from an older version of the app) is dropped rather
  // than carried out — the record comes back with the next pull.
  await deletionQueue.clearWipe(collectionName);
  const queued = await deletionQueue.pendingDeletes(collectionName);
  if (queued.length > 0) await deletionQueue.clearDeletes(collectionName, queued);

  const dirty = await store.getDirty();
  const publishable = dirty.filter((record) => record.fromCloud && record.srs);
  if (publishable.length > 0) {
    await pushProgress(dbFns, firestoreDb, collectionName, publishable);
    await store.clearDirty(publishable.map((d) => d.id));
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
   * local and safe — nothing in Firestore is deleted or overwritten, only
   * this device's own cursor is rewound.
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
    await rewindCursors();
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
      await migrateIfNeeded();
      const { db: firestoreDb, dbFns } = await getFirebase();
      const isMaster = deviceRole.isMaster();

      const wipeMarkers = await readWipeMarkers(dbFns, firestoreDb);
      const { byCollection: remoteDeletions, pullStartedAt: deletionsPulledAt } = await pullDeletions(dbFns, firestoreDb);

      const counts = {};
      for (const { store, collectionName, field } of COLLECTIONS) {
        await applyRemoteWipe(store, collectionName, wipeMarkers[collectionName] || 0);
        if (isMaster) await pushLocalWipe(dbFns, firestoreDb, collectionName);
        await store.applyRemoteDeletions(remoteDeletions[collectionName] || []);

        const cursorKey = `firestoreCursor_${collectionName}`;
        const { records: remoteRecords, pullStartedAt } = await pullCollection(dbFns, firestoreDb, collectionName, cursorKey);
        const { merged, tombstoneIds } = await store.mergeFromRemote(remoteRecords);
        counts[field] = merged.length;

        if (isMaster) {
          await pushMaster(dbFns, firestoreDb, store, collectionName, tombstoneIds);
        } else {
          await pushReader(dbFns, firestoreDb, store, collectionName);
        }

        await db.setMeta(cursorKey, pullStartedAt);
      }
      await db.setMeta('firestoreCursor_deletions', deletionsPulledAt);

      await Promise.all([db.setMeta('lastSync', Date.now()), db.setMeta('lastSyncCounts', counts)]);
      setStatus({ state: 'synced', message: 'Synchronisiert', lastSync: Date.now(), counts });
    } catch (err) {
      setStatus({ state: 'error', message: firestoreErrorMessage(err) });
    }
  }
};
