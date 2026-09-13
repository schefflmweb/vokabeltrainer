const DB_NAME = 'vokabeltrainer';
const DB_VERSION = 2;
const STORE_VOCAB = 'vocab';
const STORE_META = 'meta';
const STORE_GRAMMAR = 'grammar';

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

export const STORE_NAMES = { VOCAB: STORE_VOCAB, META: STORE_META, GRAMMAR: STORE_GRAMMAR };

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

  async getMeta(key) {
    const record = await this.get(key, STORE_META);
    return record ? record.value : undefined;
  },

  async setMeta(key, value) {
    return this.put({ key, value }, STORE_META);
  }
};
