import { db } from './db.js';

/**
 * Deletions used to be tombstones: the record stayed in IndexedDB with
 * `deleted: true` and was filtered out of every read. That made the deletion
 * itself syncable — but it also meant "alle löschen" left the whole
 * collection lying around locally and in the cloud, and a single record could
 * be resurrected from another device that still held an older copy.
 *
 * Now a delete really deletes: the record is removed from IndexedDB on the
 * spot, and only its id is kept here, in the meta store, until the next sync
 * has removed the matching document from Firestore too. A full wipe queues a
 * single timestamp instead of every id — writing 18.000 deletion markers to
 * say "everything is gone" would cost more than the delete itself.
 *
 * The queue is per collection and survives a reload, so a delete made offline
 * still reaches the cloud on the next connection instead of being silently
 * local-only.
 */

const deleteKey = (collectionName) => `pendingDeletes_${collectionName}`;
const wipeKey = (collectionName) => `pendingWipe_${collectionName}`;

export const deletionQueue = {
  async queueDeletes(collectionName, ids) {
    if (!ids || ids.length === 0) return;
    const key = deleteKey(collectionName);
    const existing = (await db.getMeta(key)) || [];
    await db.setMeta(key, [...new Set([...existing, ...ids])]);
  },

  async pendingDeletes(collectionName) {
    return (await db.getMeta(deleteKey(collectionName))) || [];
  },

  async clearDeletes(collectionName, ids) {
    const key = deleteKey(collectionName);
    const existing = (await db.getMeta(key)) || [];
    const done = new Set(ids);
    await db.setMeta(key, existing.filter((id) => !done.has(id)));
  },

  /**
   * Marks the whole collection as wiped. Any per-id deletes still queued are
   * dropped: they're about to be deleted anyway, and keeping them would make
   * the next sync delete the same documents twice.
   */
  async queueWipe(collectionName) {
    await db.setMeta(deleteKey(collectionName), []);
    await db.setMeta(wipeKey(collectionName), Date.now());
  },

  async pendingWipe(collectionName) {
    return (await db.getMeta(wipeKey(collectionName))) || 0;
  },

  async clearWipe(collectionName) {
    await db.setMeta(wipeKey(collectionName), 0);
  }
};
