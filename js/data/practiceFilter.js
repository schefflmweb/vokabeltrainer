import { db, STORE_NAMES } from './db.js';

/**
 * Which word types and categories the practice modes draw from. One shared
 * setting behind Auto, Quiz and Challenge: picking "only verbs" is a decision
 * about what you want to practise right now, not about which mode you happen
 * to be in, and keeping three separate ones would mean setting it three times.
 *
 * Empty means no restriction, which is the default — selecting nothing gives
 * the full mix. Within a dimension the picks are OR'd (noun *or* verb), across
 * dimensions they are AND'd (a noun *and* from "Essen & Trinken").
 */

const STORAGE_KEY = 'vocab-practice-filter';

let state = { types: [], categories: [] };

try {
  const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
  state = {
    types: Array.isArray(stored.types) ? stored.types : [],
    categories: Array.isArray(stored.categories) ? stored.categories : []
  };
} catch {
  // Unreadable or absent — start unfiltered.
}

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Filter still applies for this session, it just won't be remembered.
  }
}

let listeners = [];

function notify() {
  listeners.forEach((fn) => fn(state));
}

/** Distinct values across both practice stores, blanks dropped. */
async function valuesFor(indexName) {
  const lists = await Promise.all(
    [STORE_NAMES.VOCAB, STORE_NAMES.IDIOMS].map((s) => db.distinctIndexValues(s, indexName).catch(() => []))
  );
  return [...new Set(lists.flat())].filter((v) => typeof v === 'string' && v.trim()).sort((a, b) => a.localeCompare(b, 'de'));
}

export const practiceFilter = {
  get() {
    return { types: [...state.types], categories: [...state.categories] };
  },

  isActive() {
    return state.types.length > 0 || state.categories.length > 0;
  },

  toggle(dimension, value) {
    const list = state[dimension];
    const at = list.indexOf(value);
    if (at >= 0) list.splice(at, 1);
    else list.push(value);
    persist();
    notify();
  },

  clear() {
    state = { types: [], categories: [] };
    persist();
    notify();
  },

  /** Does this record pass the current filter? Records without a type/category only pass while that dimension is unrestricted. */
  matches(record) {
    if (state.types.length && !state.types.includes(record.type)) return false;
    if (state.categories.length && !state.categories.includes(record.category)) return false;
    return true;
  },

  availableTypes: () => valuesFor('type'),
  availableCategories: () => valuesFor('category'),

  onChange(fn) {
    listeners.push(fn);
    return () => {
      listeners = listeners.filter((l) => l !== fn);
    };
  }
};
