import { DB_VERSION, storesToCreate } from "./workout-storage.js";

const DB_NAME = "liftiq-local";
const STORE_NAME = "sessions";
const RAW_STORE_NAME = "rawSessions";

// IndexedDB wrapper for saved sets. Same database/store names as earlier
// versions, so existing history keeps working.
export class SessionStorage {
  static async open() {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = (event) => {
        const database = request.result;
        // Additive migration only: existing stores (sessions, rawSessions) are never touched;
        // v3 adds the workout stores (see workout-storage.js storesToCreate).
        for (const spec of storesToCreate(event.oldVersion, DB_VERSION)) {
          if (database.objectStoreNames.contains(spec.name)) continue;
          const store = database.createObjectStore(spec.name, spec.options);
          for (const [name, path] of spec.indexes) store.createIndex(name, path);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("Local storage is unavailable."));
    });
    return new SessionStorage(database);
  }

  constructor(database) {
    this.database = database;
  }

  save(session) {
    return new Promise((resolve, reject) => {
      const transaction = this.database.transaction(STORE_NAME, "readwrite");
      transaction.objectStore(STORE_NAME).put(session);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error || new Error("Could not save this set."));
      transaction.onabort = () => reject(transaction.error || new Error("Saving this set was cancelled."));
    });
  }

  getAll() {
    return new Promise((resolve, reject) => {
      const request = this.database.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).getAll();
      request.onsuccess = () => resolve(request.result.sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
      request.onerror = () => reject(request.error || new Error("Could not load set history."));
    });
  }

  saveRaw(record) {
    return new Promise((resolve, reject) => {
      const transaction = this.database.transaction(RAW_STORE_NAME, "readwrite");
      transaction.objectStore(RAW_STORE_NAME).put(record);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error || new Error("Could not save this capture."));
      transaction.onabort = () => reject(transaction.error || new Error("Saving this capture was cancelled."));
    });
  }

  getAllRaw() {
    return new Promise((resolve, reject) => {
      const request = this.database.transaction(RAW_STORE_NAME, "readonly").objectStore(RAW_STORE_NAME).getAll();
      request.onsuccess = () => resolve(request.result.sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
      request.onerror = () => reject(request.error || new Error("Could not load raw captures."));
    });
  }

  deleteRaw(id) {
    return new Promise((resolve, reject) => {
      const transaction = this.database.transaction(RAW_STORE_NAME, "readwrite");
      transaction.objectStore(RAW_STORE_NAME).delete(id);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error || new Error("Could not delete this capture."));
    });
  }

  delete(id) {
    return new Promise((resolve, reject) => {
      const transaction = this.database.transaction(STORE_NAME, "readwrite");
      transaction.objectStore(STORE_NAME).delete(id);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error || new Error("Could not delete this set."));
    });
  }
}

export async function requestPersistentStorage() {
  if (!navigator.storage?.persist) return false;
  return navigator.storage.persist();
}
