import { db } from './db.js';
import { defaultSrs, schedule } from '../srs/scheduler.js';

let idCounter = 0;
function makeId(en) {
  const slug = en.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  idCounter += 1;
  return `custom-${slug}-${Date.now().toString(36)}-${idCounter.toString(36)}`;
}

function normalizeEn(en) {
  return en.trim().toLowerCase();
}

/** Refreshes translation/category/example on an existing record without touching its learning progress. */
function applyUpdate(record, { de, category, example }) {
  record.de = de.trim();
  if (category?.trim()) record.category = category.trim();
  if (example?.trim()) record.example = example.trim();
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

  async getDue(limit = 20, now = Date.now()) {
    const all = await this.getAll();
    const due = all.filter((v) => v.srs.dueDate <= now);
    // Shuffled, not sorted by dueDate: freshly-seeded/imported words share
    // (near-)identical timestamps, so sorting left the due pool in a fixed
    // order and sessions kept showing the same first N cards every time.
    const pool = due.length > 0 ? due : all; // nothing due -> practice from everything
    const shuffled = [...pool].sort(() => Math.random() - 0.5);
    return shuffled.slice(0, limit);
  },

  /** Adds a vocab entry, or updates the existing one (by English word, case-insensitive) if it already exists — never creates a duplicate. Learning progress on an updated entry is preserved. */
  async add({ en, de, category, example }) {
    const all = await db.getAll();
    const target = normalizeEn(en);
    const existing = all.find((v) => !v.deleted && normalizeEn(v.en) === target);
    if (existing) {
      applyUpdate(existing, { de, category, example });
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

  /** Same dedup behavior as add(), batched — used by CSV import. Returns which entries were newly added vs. updated. */
  async addMany(entries) {
    const all = await db.getAll();
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

  async remove(id) {
    const record = await db.get(id);
    if (!record) return;
    record.deleted = true;
    record.updatedAt = Date.now();
    record.dirty = true;
    await db.put(record);
  },

  /** Soft-deletes every vocab entry (same tombstone mechanism as remove()) so the deletion also propagates through OneDrive sync instead of being resurrected by a later merge. */
  async removeAll() {
    const all = await this.getAll();
    const now = Date.now();
    const updated = all.map((v) => ({ ...v, deleted: true, updatedAt: now, dirty: true }));
    await db.putAll(updated);
  },

  async markReviewed(id, known) {
    const record = await db.get(id);
    if (!record) return null;
    record.srs = schedule(record.srs, known);
    record.updatedAt = Date.now();
    record.dirty = true;
    await db.put(record);
    return record;
  },

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

  /**
   * Merge a set of remote records (from OneDrive) into local storage,
   * per-record last-write-wins by updatedAt. Returns the merged full set,
   * ready to be re-uploaded.
   */
  async mergeFromRemote(remoteRecords) {
    const localAll = await db.getAll();
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
    await db.putAll(merged);
    return merged;
  }
};
