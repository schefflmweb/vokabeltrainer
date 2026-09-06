import { db, STORE_NAMES } from './db.js';
import { defaultSrs, schedule } from '../srs/scheduler.js';

const STORE = STORE_NAMES.GRAMMAR;

let idCounter = 0;
function makeId() {
  idCounter += 1;
  return `custom-grammar-${Date.now().toString(36)}-${idCounter.toString(36)}`;
}

function normalizeQuestion(question) {
  return question.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Loads the bundled starter set exactly once, ever — tracked via a meta
 * flag rather than "seed if the store is empty". Vocab used the latter
 * originally and it backfired: deleting everything left the store empty
 * again, so the next launch silently re-seeded it, and — worse — synced
 * that fresh copy could outrace a genuine delete-tombstone from another
 * device and resurrect words the user had deliberately removed. A one-time
 * flag means deleting the starter grammar set (or all of it) sticks on the
 * device it happened on — but with multiple devices, seeding a SECOND or
 * THIRD device still risks a variant of the same bug: that device seeds its
 * own fresh local copy (with today's timestamp) before it has ever synced,
 * so if it then pulls a delete-tombstone (or reviewed progress) for the
 * same starter item from another device, mergeFromRemote's last-write-wins
 * would wrongly prefer the fresh-but-stale local seed over the genuinely
 * newer remote state. Stamping seeded records with updatedAt: 0 (instead of
 * "now") closes that gap: a first-ever device still keeps its seed (nothing
 * to compare against remotely), but any later device always defers to
 * whatever real remote history already exists for that item.
 */
async function seedIfNeeded() {
  const already = await db.getMeta('grammarSeeded');
  if (already) return;
  await db.setMeta('grammarSeeded', true);
  const res = await fetch('./data/starter-grammar.json').catch(() => null);
  if (!res || !res.ok) return;
  const starter = await res.json().catch(() => []);
  const now = Date.now();
  const records = starter.map((item) => ({
    ...item,
    source: 'starter',
    deleted: false,
    createdAt: now,
    updatedAt: 0,
    dirty: false,
    srs: defaultSrs()
  }));
  await db.putAll(records, STORE);
}

const seedPromise = seedIfNeeded();

export const grammarStore = {
  /** Resolves once the one-time starter seeding attempt (see seedIfNeeded) has finished. */
  ready() {
    return seedPromise;
  },

  async getAll() {
    await seedPromise;
    const all = await db.getAll(STORE);
    return all.filter((g) => !g.deleted);
  },

  async getTopics() {
    const all = await this.getAll();
    return [...new Set(all.map((g) => g.topic).filter(Boolean))].sort();
  },

  /** Builds a practice session: due items first, then unseen/everything else, shuffled — same due→fallback shuffle vocab uses so a freshly-seeded batch doesn't show the same fixed order every time. */
  async getSession(limit = 12, topic = null, now = Date.now()) {
    const all = await this.getAll();
    const pool = topic ? all.filter((g) => g.topic === topic) : all;
    const due = pool.filter((g) => g.srs.dueDate <= now);
    const source = due.length > 0 ? due : pool;
    const shuffled = [...source].sort(() => Math.random() - 0.5);
    return shuffled.slice(0, limit);
  },

  /** Adds a custom exercise, or updates an existing one with the same question text (case/whitespace-insensitive) — never creates a duplicate. */
  async add({ topic, question, options, correctIndex, explanation }) {
    const all = await db.getAll(STORE);
    const target = normalizeQuestion(question);
    const existing = all.find((g) => !g.deleted && normalizeQuestion(g.question) === target);
    const now = Date.now();
    if (existing) {
      existing.topic = topic?.trim() || existing.topic;
      existing.options = options;
      existing.correctIndex = correctIndex;
      existing.explanation = explanation?.trim() || '';
      existing.updatedAt = now;
      existing.dirty = true;
      await db.put(existing, STORE);
      return existing;
    }
    const record = {
      id: makeId(),
      topic: topic?.trim() || 'Eigene',
      question: question.trim(),
      options,
      correctIndex,
      explanation: explanation?.trim() || '',
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
  async addMany(entries) {
    const all = await db.getAll(STORE);
    const byQuestion = new Map(all.filter((g) => !g.deleted).map((g) => [normalizeQuestion(g.question), g]));
    const now = Date.now();
    const added = [];
    const updated = [];

    for (const e of entries) {
      const target = normalizeQuestion(e.question);
      const existing = byQuestion.get(target);
      if (existing) {
        existing.topic = e.topic?.trim() || existing.topic;
        existing.options = e.options;
        existing.correctIndex = e.correctIndex;
        existing.explanation = e.explanation?.trim() || '';
        existing.updatedAt = now;
        existing.dirty = true;
        updated.push(existing);
      } else {
        const record = {
          id: makeId(),
          topic: e.topic?.trim() || 'Eigene',
          question: e.question.trim(),
          options: e.options,
          correctIndex: e.correctIndex,
          explanation: e.explanation?.trim() || '',
          source: 'custom',
          deleted: false,
          createdAt: now,
          updatedAt: now,
          dirty: true,
          srs: defaultSrs()
        };
        byQuestion.set(target, record);
        added.push(record);
      }
    }

    await db.putAll([...added, ...updated], STORE);
    return { added, updated };
  },

  async remove(id) {
    const record = await db.get(id, STORE);
    if (!record) return;
    record.deleted = true;
    record.updatedAt = Date.now();
    record.dirty = true;
    await db.put(record, STORE);
  },

  async removeAll() {
    const all = await this.getAll();
    const now = Date.now();
    const updated = all.map((g) => ({ ...g, deleted: true, updatedAt: now, dirty: true }));
    await db.putAll(updated, STORE);
  },

  async markReviewed(id, correct) {
    const record = await db.get(id, STORE);
    if (!record) return null;
    record.srs = schedule(record.srs, correct);
    record.updatedAt = Date.now();
    record.dirty = true;
    await db.put(record, STORE);
    return record;
  },

  async getDirty() {
    const all = await db.getAll(STORE);
    return all.filter((g) => g.dirty);
  },

  async clearDirty(ids) {
    const set = new Set(ids);
    const all = await db.getAll(STORE);
    const toClear = all.filter((g) => set.has(g.id));
    for (const record of toClear) record.dirty = false;
    await db.putAll(toClear, STORE);
  },

  /** Same per-record last-write-wins merge as vocabStore — kept here ready for when OneDrive sync is extended to grammar too. */
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
