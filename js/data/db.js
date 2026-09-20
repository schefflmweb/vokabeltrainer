const DB_NAME = 'vokabeltrainer';
const DB_VERSION = 4;
const STORE_VOCAB = 'vocab';
const STORE_META = 'meta';
const STORE_GRAMMAR = 'grammar';
const STORE_IDIOMS = 'idioms';

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_VOCAB)) {
        const store = db.createObjectStore(STORE_VOCAB, { keyPath: 'id' });
        store.createIndex('dueDate', 'srs.dueDate', { unique: false });
        store.createIndex('dirty', 'dirty', { unique: false });
        store.createIndex('category', 'category', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_META)) {
        db.createObjectStore(STORE_META, { keyPath: 'key' });
      }
      // v2: grammar exercises, added alongside vocab — same shape of store
      // (id/srs/dirty), kept separate so its indices/records never mix with
      // vocab's.
      if (!db.objectStoreNames.contains(STORE_GRAMMAR)) {
        const store = db.createObjectStore(STORE_GRAMMAR, { keyPath: 'id' });
        store.createIndex('dueDate', 'srs.dueDate', { unique: false });
        store.createIndex('dirty', 'dirty', { unique: false });
        store.createIndex('topic', 'topic', { unique: false });
      }
      // v3: idioms — same shape as vocab (en/de/example/category/srs), kept
      // in its own store so its own "list" and count stay separate from
      // vocab's rather than inflating it, while Auto/Quiz mode can still
      // practice from either or both pools.
      if (!db.objectStoreNames.contains(STORE_IDIOMS)) {
        const store = db.createObjectStore(STORE_IDIOMS, { keyPath: 'id' });
        store.createIndex('dueDate', 'srs.dueDate', { unique: false });
        store.createIndex('dirty', 'dirty', { unique: false });
        store.createIndex('category', 'category', { unique: false });
      }
      // v4: a word-type index next to the existing category one, so practising
      // a chosen type or category can read just those records. Without it a
      // narrow pick (a few dozen interjections among thousands of words) would
      // have to scan the store to find anything at all.
      for (const name of [STORE_VOCAB, STORE_IDIOMS]) {
        const store = req.transaction.objectStore(name);
        if (!store.indexNames.contains('type')) store.createIndex('type', 'type', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(storeName, mode) {
  return openDb().then((db) => db.transaction(storeName, mode).objectStore(storeName));
}

function wrapRequest(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export const STORE_NAMES = { VOCAB: STORE_VOCAB, META: STORE_META, GRAMMAR: STORE_GRAMMAR, IDIOMS: STORE_IDIOMS };

export const db = {
  async getAll(storeName = STORE_VOCAB) {
    const store = await tx(storeName, 'readonly');
    return wrapRequest(store.getAll());
  },

  async get(id, storeName = STORE_VOCAB) {
    const store = await tx(storeName, 'readonly');
    return wrapRequest(store.get(id));
  },

  async put(record, storeName = STORE_VOCAB) {
    const store = await tx(storeName, 'readwrite');
    return wrapRequest(store.put(record));
  },

  async putAll(records, storeName = STORE_VOCAB) {
    const db_ = await openDb();
    const store = db_.transaction(storeName, 'readwrite').objectStore(storeName);
    await Promise.all(records.map((r) => wrapRequest(store.put(r))));
  },

  async delete(id, storeName = STORE_VOCAB) {
    const store = await tx(storeName, 'readwrite');
    return wrapRequest(store.delete(id));
  },

  async count(storeName = STORE_VOCAB) {
    const store = await tx(storeName, 'readonly');
    return wrapRequest(store.count());
  },

  /**
   * Reads up to `cap` records from `indexName` whose key falls in `range`,
   * starting at a random position within that range — avoids deserializing
   * the whole store just to find a handful of due items, while still
   * varying which ones come back. A plain from-the-start cursor would
   * always return the same records first on ties (e.g. right after a bulk
   * import, where thousands of rows share the same dueDate and IndexedDB
   * breaks the tie by primary key, i.e. always the same order).
   */
  async queryIndex(storeName, indexName, range, cap) {
    const store = await tx(storeName, 'readonly');
    const index = store.index(indexName);
    const total = await wrapRequest(index.count(range));
    return new Promise((resolve, reject) => {
      const results = [];
      const maxStart = Math.max(0, total - cap);
      const start = maxStart > 0 ? Math.floor(Math.random() * maxStart) : 0;
      let advanced = start === 0;
      const req = index.openCursor(range);
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) {
          resolve(results);
          return;
        }
        if (!advanced) {
          advanced = true;
          cursor.advance(start);
          return;
        }
        if (results.length >= cap) {
          resolve(results);
          return;
        }
        results.push(cursor.value);
        cursor.continue();
      };
      req.onerror = () => reject(req.error);
    });
  },

  /** Reads up to `cap` records starting at a random position in the store — a cheap-ish way to get a representative sample without loading everything. */
  async samplePool(storeName, cap) {
    const total = await this.count(storeName);
    const store = await tx(storeName, 'readonly');
    return new Promise((resolve, reject) => {
      const results = [];
      const maxStart = Math.max(0, total - cap);
      const start = maxStart > 0 ? Math.floor(Math.random() * maxStart) : 0;
      let advanced = start === 0;
      const req = store.openCursor();
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) {
          resolve(results);
          return;
        }
        if (!advanced) {
          advanced = true;
          cursor.advance(start);
          return;
        }
        if (results.length >= cap) {
          resolve(results);
          return;
        }
        results.push(cursor.value);
        cursor.continue();
      };
      req.onerror = () => reject(req.error);
    });
  },

  /**
   * Up to `cap` records matching a {types, categories} filter. Reads through
   * whichever of the two indexes has fewer values picked — that one narrows
   * the store the most — and checks the other dimension on the records that
   * come back.
   */
  async filteredPool(storeName, filter, cap) {
    const byType = filter.types?.length ? { index: 'type', values: filter.types } : null;
    const byCategory = filter.categories?.length ? { index: 'category', values: filter.categories } : null;
    const driver = byType && byCategory
      ? (byType.values.length <= byCategory.values.length ? byType : byCategory)
      : (byType || byCategory);
    if (!driver) return this.samplePool(storeName, cap);
    const pool = await this.queryIndexAny(storeName, driver.index, driver.values, cap);
    return pool.filter((r) => {
      if (byType && !byType.values.includes(r.type)) return false;
      if (byCategory && !byCategory.values.includes(r.category)) return false;
      return true;
    });
  },

  /** Every distinct value an index holds, read straight from the index rather than from the records. */
  async distinctIndexValues(storeName, indexName) {
    const store = await tx(storeName, 'readonly');
    const index = store.index(indexName);
    return new Promise((resolve, reject) => {
      const values = [];
      const req = index.openKeyCursor(null, 'nextunique');
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) {
          resolve(values);
          return;
        }
        values.push(cursor.key);
        cursor.continue();
      };
      req.onerror = () => reject(req.error);
    });
  },

  /** Up to `cap` records whose index key is any of `values` — the union, shuffled together. */
  async queryIndexAny(storeName, indexName, values, cap) {
    const perValue = Math.max(1, Math.ceil(cap / values.length));
    const lists = await Promise.all(
      values.map((v) => this.queryIndex(storeName, indexName, IDBKeyRange.only(v), perValue))
    );
    return lists.flat().sort(() => Math.random() - 0.5).slice(0, cap);
  },

  async getMeta(key) {
    const record = await this.get(key, STORE_META);
    return record ? record.value : undefined;
  },

  async setMeta(key, value) {
    return this.put({ key, value }, STORE_META);
  }
};
