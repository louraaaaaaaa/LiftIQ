const DB_NAME = "liftiq-local";
const DB_VERSION = 1;
const STORE_NAME = "sessions";

// IndexedDB wrapper for saved sets. Same database/store names as earlier
// versions, so existing history keeps working.
export class SessionStorage {
  static async open() {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const store = request.result.createObjectStore(STORE_NAME, { keyPath: "id" });
        store.createIndex("createdAt", "createdAt");
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
