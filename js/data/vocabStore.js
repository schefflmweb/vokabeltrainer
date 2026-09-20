import { db, STORE_NAMES } from './db.js';
import { defaultSrs, schedule } from '../srs/scheduler.js';
import { touchStreak, getStreak } from './streak.js';
import { deletionQueue } from './deletionQueue.js';
import { mergeRemoteRecords } from './remoteMerge.js';

// How many candidate records getDue() reads via the dueDate index before
// shuffling and slicing to the requested session size. Well above any
// realistic session size so shuffled results stay varied, but far below the
// full collection — with large imports (thousands of words) reading
// everything just to pick ~15 due items made session start noticeably slow.
const DUE_POOL_CAP = 400;

let idCounter = 0;
function makeId(en) {
  const slug = en.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  idCounter += 1;
  return `custom-${slug}-${Date.now().toString(36)}-${idCounter.toString(36)}`;
}

function normalizeEn(en) {
  return en.trim().toLowerCase();
}

/** Refreshes translation/category/example/type on an existing record without touching its learning progress. */
function applyUpdate(record, { de, category, example, type }) {
  record.de = de.trim();
  if (category?.trim()) record.category = category.trim();
  if (example?.trim()) record.example = example.trim();
  if (type?.trim()) record.type = type.trim();
  record.updatedAt = Date.now();
  record.dirty = true;
  return record;
}

export const vocabStore = {
  async getAll() {
    const all = await db.getAll();
    return all.filter((v) => !v.deleted);
  },

  async getById(id) {
    return db.get(id);
  },

  /** A random subset, for callers that just need "a bunch of other words" (e.g. multiple-choice distractors) without loading the whole collection. `filter` restricts it to chosen word types/categories. */
  async getSample(cap = 150, filter = null) {
    const pool = filter
      ? await db.filteredPool(STORE_NAMES.VOCAB, filter, cap)
      : await db.samplePool(STORE_NAMES.VOCAB, cap);
    return pool.filter((v) => !v.deleted);
  },

  async getDue(limit = 20, now = Date.now(), filter = null) {
    // A filtered session reads by type/category index instead of by due date:
    // the chosen slice can be a tiny part of the collection, and a due-date
    // window would mostly come back with words the filter then throws away.
    // Due ones are still preferred, just picked out in memory.
    if (filter) {
      const pool = (await db.filteredPool(STORE_NAMES.VOCAB, filter, DUE_POOL_CAP)).filter((v) => !v.deleted);
      const due = pool.filter((v) => (v.srs?.dueDate ?? 0) <= now);
      const base = due.length > 0 ? due : pool;
      return [...base].sort(() => Math.random() - 0.5).slice(0, limit);
    }
    // Reads via the dueDate index instead of the whole store — with a large
    // collection, loading every record just to find ~15 due ones made every
    // session start slow.
    let pool = (await db.queryIndex(STORE_NAMES.VOCAB, 'dueDate', IDBKeyRange.upperBound(now), DUE_POOL_CAP))
      .filter((v) => !v.deleted);
    if (pool.length === 0) {
      // Nothing due -> practice from a random sample of everything, rather
      // than loading the full collection.
      pool = (await db.samplePool(STORE_NAMES.VOCAB, DUE_POOL_CAP)).filter((v) => !v.deleted);
    }
    // Shuffled, not sorted by dueDate: freshly-seeded/imported words share
    // (near-)identical timestamps, so sorting left the due pool in a fixed
    // order and sessions kept showing the same first N cards every time.
    const shuffled = [...pool].sort(() => Math.random() - 0.5);
    return shuffled.slice(0, limit);
  },

  /**
   * Adds a vocab entry, or updates the existing one (by English word,
   * case-insensitive) if it already exists — never creates a duplicate.
   * Learning progress on an updated entry is preserved. `knownList`, if
   * given, is used for the dedup check instead of a fresh full-table scan —
   * callers that already keep the full list in memory (e.g. manageMode's
   * vocabCache) should pass it, since a getAll() per single add gets slow
   * once the collection is large.
   */
  async add({ en, de, category, example, type }, knownList = null) {
    const all = knownList || await db.getAll();
    const target = normalizeEn(en);
    const existing = all.find((v) => !v.deleted && normalizeEn(v.en) === target);
    if (existing) {
      applyUpdate(existing, { de, category, example, type });
      await db.put(existing);
      return existing;
    }

    const now = Date.now();
    const record = {
      id: makeId(en),
      en: en.trim(),
      de: de.trim(),
      category: category?.trim() || 'Eigene',
      example: example?.trim() || '',
      type: type?.trim() || '',
      source: 'custom',
      deleted: false,
      createdAt: now,
      updatedAt: now,
      dirty: true,
      srs: defaultSrs()
    };
    await db.put(record);
    return record;
  },

  /** Same dedup behavior as add(), batched — used by CSV import. Returns which entries were newly added vs. updated. Same `knownList` optimization as add(). */
  async addMany(entries, knownList = null) {
    const all = knownList || await db.getAll();
    const byEn = new Map(all.filter((v) => !v.deleted).map((v) => [normalizeEn(v.en), v]));
    const now = Date.now();
    const added = [];
    const updated = [];

    for (const e of entries) {
      const target = normalizeEn(e.en);
      const existing = byEn.get(target);
      if (existing) {
        applyUpdate(existing, e);
        updated.push(existing);
      } else {
        const record = {
          id: makeId(e.en),
          en: e.en.trim(),
          de: e.de.trim(),
          category: e.category?.trim() || 'Eigene',
          example: e.example?.trim() || '',
          type: e.type?.trim() || '',
          source: 'custom',
          deleted: false,
          createdAt: now,
          updatedAt: now,
          dirty: true,
          srs: defaultSrs()
        };
        byEn.set(target, record);
        added.push(record);
      }
    }

    await db.putAll([...added, ...updated]);
    return { added, updated };
  },

  /** Directly overwrites an existing entry's fields by id — used for manual edits (a targeted single-record change, unlike add()'s collision-avoiding upsert). Learning progress is untouched. */
  async update(id, { en, de, category, example, type }) {
    const record = await db.get(id);
    if (!record) return null;
    record.en = en.trim();
    record.de = de.trim();
    record.category = category?.trim() || 'Eigene';
    record.example = example?.trim() || '';
    record.type = type?.trim() || '';
    record.updatedAt = Date.now();
    record.dirty = true;
    await db.put(record);
    return record;
  },

  /** Really removes the entry here and queues its id so the next sync removes it from Firestore too. No tombstone, nothing to restore. */
  async remove(id) {
    const record = await db.get(id);
    if (!record) return;
    await db.delete(id);
    await deletionQueue.queueDeletes(STORE_NAMES.VOCAB, [id]);
  },

  /** Empties the whole collection here and marks it for deletion in the cloud — one wipe marker instead of one id per record. */
  async removeAll() {
    await db.clear();
    await deletionQueue.queueWipe(STORE_NAMES.VOCAB);
  },

  /** Drops local records the cloud says are gone (deletion markers pulled by syncService). Silently ignores ids this device never had. */
  async applyRemoteDeletions(ids) {
    if (!ids || ids.length === 0) return;
    await db.deleteAll(ids);
  },

  /** Empties the store without queueing anything — for a reader applying a wipe the master already carried out in the cloud. */
  async clearLocal() {
    await db.clear();
  },

  /**
   * Removes leftovers from the tombstone era (`deleted: true` records kept
   * in the store instead of being deleted). Read paths still filter them out
   * as well, so a purge that hasn't finished yet can't briefly resurrect a
   * deleted word.
   */
  async purgeTombstones() {
    const all = await db.getAll();
    const ids = all.filter((v) => v.deleted).map((v) => v.id);
    if (ids.length > 0) await db.deleteAll(ids);
    return ids.length;
  },

  async markReviewed(id, known) {
    const record = await db.get(id);
    if (!record) return null;
    record.srs = schedule(record.srs, known);
    record.updatedAt = Date.now();
    record.dirty = true;
    await db.put(record);
    touchStreak();
    return record;
  },

  getStreak,

  async getDirty() {
    const all = await db.getAll();
    return all.filter((v) => v.dirty);
  },

  async clearDirty(ids) {
    const set = new Set(ids);
    const all = await db.getAll();
    const toClear = all.filter((v) => set.has(v.id));
    for (const record of toClear) {
      record.dirty = false;
    }
    await db.putAll(toClear);
  },

  mergeFromRemote(remoteRecords) {
    return mergeRemoteRecords(STORE_NAMES.VOCAB, remoteRecords);
  }
};
