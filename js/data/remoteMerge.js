import { db } from './db.js';

/**
 * Merges records pulled from Firestore into one local store, per-record
 * last-write-wins by updatedAt. Shared by vocab, grammar and idioms: the
 * three stores held byte-identical copies of this before, and the rules
 * below are subtle enough that three copies would eventually disagree.
 *
 * Two things beyond the plain merge:
 *
 * `fromCloud` marks records this device has actually seen in the cloud. A
 * reader device pushes learning progress only for those — without the marker
 * it couldn't tell a record the PC published from one that only ever existed
 * locally, and pushing the latter would create master data from a device
 * that isn't allowed to. It's local bookkeeping and never reaches Firestore
 * (syncService strips it, same as `dirty`).
 *
 * Remote records still carrying `deleted: true` are tombstones written
 * before deletes became real. They're applied as deletions and reported back
 * so the master device can clear them out of Firestore for good.
 */
export async function mergeRemoteRecords(storeName, remoteRecords) {
  const incoming = remoteRecords || [];
  const tombstoneIds = incoming.filter((r) => r.deleted).map((r) => r.id);
  if (tombstoneIds.length > 0) await db.deleteAll(tombstoneIds, storeName);

  const localAll = (await db.getAll(storeName)).filter((r) => !r.deleted);
  const localById = new Map(localAll.map((r) => [r.id, r]));
  const remoteById = new Map(incoming.filter((r) => !r.deleted).map((r) => [r.id, r]));
  const allIds = new Set([...localById.keys(), ...remoteById.keys()]);

  const merged = [];
  for (const id of allIds) {
    const local = localById.get(id);
    const remote = remoteById.get(id);
    if (local && remote) {
      merged.push(remote.updatedAt > local.updatedAt
        ? { ...remote, dirty: false, fromCloud: true }
        : { ...local, fromCloud: true });
    } else if (local) {
      merged.push(local);
    } else {
      merged.push({ ...remote, dirty: false, fromCloud: true });
    }
  }
  await db.putAll(merged, storeName);
  return { merged, tombstoneIds };
}
