import { db, STORE_NAMES } from './db.js';
import { defaultSrs, schedule } from '../srs/scheduler.js';
import { deletionQueue } from './deletionQueue.js';
import { mergeRemoteRecords } from './remoteMerge.js';

const STORE = STORE_NAMES.GRAMMAR;

let idCounter = 0;
function makeId() {
  idCounter += 1;
  return `custom-grammar-${Date.now().toString(36)}-${idCounter.toString(36)}`;
}

function normalizeQuestion(question) {
  return question.trim().toLowerCase().replace(/\s+/g, ' ');
}

export const grammarStore = {
  async getAll() {
    const all = await db.getAll(STORE);
    return all.filter((g) => !g.deleted);
  },

  async getTopics() {
    const all = await this.getAll();
    return [...new Set(all.map((g) => g.topic).filter(Boolean))].sort();
  },

  /** A random subset, for callers that just need "a few grammar questions" without loading the whole collection — same samplePool-based pattern as vocabStore/idiomStore's getSample(). Used by the Bierdeckel-Challenge's grammar pot. */
  async getSample(cap = 50) {
    const pool = await db.samplePool(STORE, cap);
    return pool.filter((g) => !g.deleted);
  },

  /** Builds a practice session: due items first, then unseen/everything else, shuffled — same due→fallback shuffle vocab uses so a freshly-imported batch doesn't show the same fixed order every time. */
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

  /** Same hard delete as vocabStore.remove(): gone here, queued for removal from Firestore. */
  async remove(id) {
    const record = await db.get(id, STORE);
    if (!record) return;
    await db.delete(id, STORE);
    await deletionQueue.queueDeletes(STORE, [id]);
  },

  async removeAll() {
    await db.clear(STORE);
    await deletionQueue.queueWipe(STORE);
  },

  async applyRemoteDeletions(ids) {
    if (!ids || ids.length === 0) return;
    await db.deleteAll(ids, STORE);
  },

  async clearLocal() {
    await db.clear(STORE);
  },

  async purgeTombstones() {
    const all = await db.getAll(STORE);
    const ids = all.filter((g) => g.deleted).map((g) => g.id);
    if (ids.length > 0) await db.deleteAll(ids, STORE);
    return ids.length;
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

  mergeFromRemote(remoteRecords) {
    return mergeRemoteRecords(STORE, remoteRecords);
  }
};
