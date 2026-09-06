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

  async getMeta(key) {
    const record = await this.get(key, STORE_META);
    return record ? record.value : undefined;
  },

  async setMeta(key, value) {
    return this.put({ key, value }, STORE_META);
  }
};
