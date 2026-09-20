import { vocabStore } from './vocabStore.js';
import { idiomStore } from './idiomStore.js';
import { practiceFilter } from './practiceFilter.js';

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

/** True if a card returned by getDueFromSource()/getSampleFromSource() came from the vocab store rather than idioms — lets callers show vocab-only details (e.g. word type) without importing vocabStore themselves just for the identity check. */
export function isVocabCard(card) {
  return card.__store === vocabStore;
}

/** The chosen word types/categories, or null while nothing is picked (= practise everything). */
function activeFilter() {
  return practiceFilter.isActive() ? practiceFilter.get() : null;
}

export async function getDueFromSource(source, limit, now = Date.now()) {
  const stores = storesFor(source);
  const filter = activeFilter();
  if (stores.length === 1) {
    return tag(await stores[0].getDue(limit, now, filter), stores[0]);
  }
  const lists = await Promise.all(stores.map((s) => s.getDue(limit, now, filter).then((items) => tag(items, s))));
  const merged = lists.flat();
  return [...merged].sort(() => Math.random() - 0.5).slice(0, limit);
}

async function getSampleFromSource(source, cap) {
  const stores = storesFor(source);
  const filter = activeFilter();
  if (stores.length === 1) {
    return tag(await stores[0].getSample(cap, filter), stores[0]);
  }
  const lists = await Promise.all(stores.map((s) => s.getSample(Math.ceil(cap / stores.length), filter).then((items) => tag(items, s))));
  return lists.flat();
}

/**
 * A pool to draw multiple-choice distractors from. The word type/category
 * selection says what to *practise*, not which words may show up as wrong
 * options — and a narrow selection (say "Interjection" plus one category)
 * can hold fewer words than a question needs options, which would leave a
 * question with a single, unmissable answer. So a pool that thin gets
 * topped up from the unfiltered collection.
 */
export async function getDistractorSample(source, cap, minimum = 4) {
  const filtered = await getSampleFromSource(source, cap);
  if (filtered.length >= minimum) return filtered;
  const stores = storesFor(source);
  const lists = await Promise.all(
    stores.map((s) => s.getSample(Math.ceil(cap / stores.length)).then((items) => tag(items, s)))
  );
  const keyOf = (card) => `${isVocabCard(card) ? 'v' : 'i'}:${card.id}`;
  const seen = new Set(filtered.map(keyOf));
  return [...filtered, ...lists.flat().filter((card) => !seen.has(keyOf(card)))];
}
