import { vocabStore } from './vocabStore.js';
import { idiomStore } from './idiomStore.js';

/**
 * Auto/Quiz mode can practice vocab, idioms, or both mixed together. This
 * resolves a source key to the underlying store(s) and merges their due/
 * sample pools, tagging each card with the store it came from so
 * markReviewed() can be routed back to the right one — shared by both
 * modes so "how vocab and idioms get mixed" only has one implementation
 * to get right, not two that could quietly drift apart.
 */
export const PRACTICE_SOURCES = [
  { key: 'vocab', label: 'Vokabeln' },
  { key: 'idioms', label: 'Idioms' },
  { key: 'both', label: 'Beide' }
];

function storesFor(source) {
  if (source === 'vocab') return [vocabStore];
  if (source === 'idioms') return [idiomStore];
  return [vocabStore, idiomStore];
}

function tag(items, store) {
  return items.map((item) => ({ ...item, __store: store }));
}

export async function getDueFromSource(source, limit, now = Date.now()) {
  const stores = storesFor(source);
  if (stores.length === 1) {
    return tag(await stores[0].getDue(limit, now), stores[0]);
  }
  const lists = await Promise.all(stores.map((s) => s.getDue(limit, now).then((items) => tag(items, s))));
  const merged = lists.flat();
  return [...merged].sort(() => Math.random() - 0.5).slice(0, limit);
}

export async function getSampleFromSource(source, cap) {
  const stores = storesFor(source);
  if (stores.length === 1) {
    return tag(await stores[0].getSample(cap), stores[0]);
  }
  const lists = await Promise.all(stores.map((s) => s.getSample(Math.ceil(cap / stores.length)).then((items) => tag(items, s))));
  return lists.flat();
}
