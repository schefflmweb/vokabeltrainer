import { db, STORE_NAMES } from './db.js';
import { defaultSrs, schedule } from '../srs/scheduler.js';
import { touchStreak, getStreak } from './streak.js';

/**
 * Same shape and behavior as vocabStore (records look identical: en/de/
 * category/example/type/srs), just kept in its own IndexedDB store and
 * Firestore collection — an idiom import shouldn't inflate "Vokabeln
 * gesamt" or dilute the vocab practice pool, but Auto/Quiz mode can still
 * pull from this store directly, or mixed with vocab, when the user picks
 * that as the practice source (see quizMode.js/audioMode.js).
 */
const STORE = STORE_NAMES.IDIOMS;

const DUE_POOL_CAP = 400;

let idCounter = 0;
function makeId(en) {
  const slug = en.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  idCounter += 1;
  return `idiom-${slug}-${Date.now().toString(36)}-${idCounter.toString(36)}`;
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

export const idiomStore = {
  async getAll() {
    const all = await db.getAll(STORE);
    return all.filter((v) => !v.deleted);
  },

  async getById(id) {
    return db.get(id, STORE);
  },

  /** A random subset, for callers that just need "a bunch of other idioms" (e.g. multiple-choice distractors) without loading the whole collection. */
  async getSample(cap = 150) {
    const pool = await db.samplePool(STORE, cap);
    return pool.filter((v) => !v.deleted);
  },

  async getDue(limit = 20, now = Date.now()) {
    let pool = (await db.queryIndex(STORE, 'dueDate', IDBKeyRange.upperBound(now), DUE_POOL_CAP))
      .filter((v) => !v.deleted);
    if (pool.length === 0) {
      pool = (await db.samplePool(STORE, DUE_POOL_CAP)).filter((v) => !v.deleted);
    }
    const shuffled = [...pool].sort(() => Math.random() - 0.5);
    return shuffled.slice(0, limit);
  },

  /** Adds an idiom entry, or updates the existing one (by English phrase, case-insensitive) if it already exists — never creates a duplicate. `knownList`, if given, is used for the dedup check instead of a fresh full-table scan. */
  async add({ en, de, category, example, type }, knownList = null) {
    const all = knownList || await db.getAll(STORE);
    const target = normalizeEn(en);
    const existing = all.find((v) => !v.deleted && normalizeEn(v.en) === target);
    if (existing) {
      applyUpdate(existing, { de, category, example, type });
      await db.put(existing, STORE);
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
    await db.put(record, STORE);
    return record;
  },

  /** Same dedup behavior as add(), batched — used by CSV import. */
  async addMany(entries, knownList = null) {
    const all = knownList || await db.getAll(STORE);
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

    await db.putAll([...added, ...updated], STORE);
    return { added, updated };
  },

  /** Directly overwrites an existing entry's fields by id — used for manual edits. Learning progress is untouched. */
  async update(id, { en, de, category, example, type }) {
    const record = await db.get(id, STORE);
    if (!record) return null;
    record.en = en.trim();
    record.de = de.trim();
    record.category = category?.trim() || 'Eigene';
    record.example = example?.trim() || '';
    record.type = type?.trim() || '';
    record.updatedAt = Date.now();
    record.dirty = true;
    await db.put(record, STORE);
    return record;
  },

  async remove(id) {
    const record = await db.get(id, STORE);
    if (!record) return;
    record.deleted = true;
    record.updatedAt = Date.now();
    record.dirty = true;
    await db.put(record, STORE);
  },

  /** Soft-deletes every idiom entry (same tombstone mechanism as remove()) so the deletion also propagates through sync instead of being resurrected by a later merge. */
  async removeAll() {
    const all = await this.getAll();
    const now = Date.now();
    const updated = all.map((v) => ({ ...v, deleted: true, updatedAt: now, dirty: true }));
    await db.putAll(updated, STORE);
  },

  async getDeletedCount() {
    const all = await db.getAll(STORE);
    return all.filter((v) => v.deleted).length;
  },

  async restoreAllDeleted() {
    const all = await db.getAll(STORE);
    const now = Date.now();
    const toRestore = all.filter((v) => v.deleted).map((v) => ({ ...v, deleted: false, updatedAt: now, dirty: true }));
    await db.putAll(toRestore, STORE);
    return toRestore.length;
  },

  async markReviewed(id, known) {
    const record = await db.get(id, STORE);
    if (!record) return null;
    record.srs = schedule(record.srs, known);
    record.updatedAt = Date.now();
    record.dirty = true;
    await db.put(record, STORE);
    touchStreak(); // shared with vocabStore — one combined daily streak, not a separate one per collection
    return record;
  },

  getStreak,

  async getDirty() {
    const all = await db.getAll(STORE);
    return all.filter((v) => v.dirty);
  },

  async clearDirty(ids) {
    const set = new Set(ids);
    const all = await db.getAll(STORE);
    const toClear = all.filter((v) => set.has(v.id));
    for (const record of toClear) {
      record.dirty = false;
    }
    await db.putAll(toClear, STORE);
  },

  /** Same per-record last-write-wins merge as vocabStore — used by syncService for the idioms collection. */
  async mergeFromRemote(remoteRecords) {
    const localAll = await db.getAll(STORE);
    const localById = new Map(localAll.map((r) => [r.id, r]));
    const remoteById = new Map((remoteRecords || []).map((r) => [r.id, r]));
    const allIds = new Set([...localById.keys(), ...remoteById.keys()]);

    const merged = [];
    for (const id of allIds) {
      const local = localById.get(id);
      const remote = remoteById.get(id);
      if (local && remote) {
        merged.push(remote.updatedAt > local.updatedAt ? { ...remote, dirty: false } : local);
      } else if (local) {
        merged.push(local);
      } else {
        merged.push({ ...remote, dirty: false });
      }
    }
    await db.putAll(merged, STORE);
    return merged;
  }
};
