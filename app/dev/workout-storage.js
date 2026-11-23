// Storage for the workout flow (exercises, workouts, sets, set samples, active workout).
// The interface is implemented by MemoryWorkoutStorage (tests, fallback) and IdbWorkoutStorage
// (thin IndexedDB code sharing the "liftiq-local" database with the legacy stores).

export const DB_NAME = "liftiq-local";
export const DB_VERSION = 4;
// The legacy stores ("sessions" v1, "rawSessions" v2) are created by storage.js and never touched here.
export const V3_STORES = Object.freeze([
  { name: "exercises", options: { keyPath: "id" }, indexes: [] },
  { name: "workouts", options: { keyPath: "id" }, indexes: [["startedAt", "startedAt"]] },
  { name: "sets", options: { keyPath: "id" }, indexes: [["workoutId", "workoutId"], ["startedAt", "startedAt"]] },
  { name: "setSamples", options: { keyPath: "setId" }, indexes: [] },
  { name: "meta", options: { keyPath: "key" }, indexes: [] },
]);

// v4 (additive): user photos of machines. Photos live in their own store so later upgrades never touch them.
export const V4_STORES = Object.freeze([
  { name: "photos", options: { keyPath: "exerciseId" }, indexes: [] },
]);

/** Pure: which object stores a database at `oldVersion` must still create to reach `newVersion`. */
export function storesToCreate(oldVersion, newVersion = DB_VERSION) {
  const out = [];
  if (oldVersion < 1 && newVersion >= 1) out.push({ name: "sessions", options: { keyPath: "id" }, indexes: [["createdAt", "createdAt"]] });
  if (oldVersion < 2 && newVersion >= 2) out.push({ name: "rawSessions", options: { keyPath: "id" }, indexes: [["createdAt", "createdAt"]] });
  if (oldVersion < 3 && newVersion >= 3) out.push(...V3_STORES);
  if (oldVersion < 4 && newVersion >= 4) out.push(...V4_STORES);
  return out;
}

const clone = (value) => (value === undefined ? value : structuredClone(value));
const byStart = (a, b) => String(b.startedAt).localeCompare(String(a.startedAt));

export class MemoryWorkoutStorage {
  constructor() {
    this.exercises = new Map();
    this.workouts = new Map();
    this.sets = new Map();
    this.samples = new Map();
    this.active = null;
    this.photos = new Map();
    this.failNextSave = false;
  }

  async getExercises() { return [...this.exercises.values()].map(clone); }
  async saveExercise(exercise) { this.exercises.set(exercise.id, clone(exercise)); }
  async deleteExercise(id) { this.exercises.delete(id); this.photos.delete(id); }

  async getPhotos() { return [...this.photos.values()].map(clone); }
  async getPhoto(exerciseId) { return clone(this.photos.get(exerciseId)); }
  async savePhoto(photo) { this.photos.set(photo.exerciseId, clone(photo)); }
  async deletePhoto(exerciseId) { this.photos.delete(exerciseId); }

  async getWorkouts() { return [...this.workouts.values()].map(clone).sort(byStart); }
  async getWorkout(id) { return clone(this.workouts.get(id)); }
  async saveWorkout(workout) { this.workouts.set(workout.id, clone(workout)); }
  async deleteWorkout(id) {
    this.workouts.delete(id);
    for (const [setId, set] of this.sets) if (set.workoutId === id) { this.sets.delete(setId); this.samples.delete(setId); }
  }

  async saveSet(set, samples) {
    if (this.failNextSave) { this.failNextSave = false; throw new Error("disk full"); }
    this.sets.set(set.id, clone(set));
    if (samples) this.samples.set(set.id, clone(samples));
  }
  async updateSet(set) { this.sets.set(set.id, clone(set)); }
  async getSet(id) { return clone(this.sets.get(id)); }
  async getSets() { return [...this.sets.values()].map(clone).sort(byStart); }
  async getSamples(id) { return clone(this.samples.get(id)); }
  async deleteSet(id) { this.sets.delete(id); this.samples.delete(id); }

  async getActive() { return clone(this.active); }
  async setActive(value) { this.active = clone(value); }
  async clearActive() { this.active = null; }
}

export class IdbWorkoutStorage {
  constructor(database) { this.db = database; }

  #run(stores, mode, work) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(stores, mode);
      let result;
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error || new Error("Storage error."));
      tx.onabort = () => reject(tx.error || new Error("Storage transaction aborted."));
      const out = work(tx);
      if (out && typeof out.then === "function") out.then((v) => { result = v; }, reject);
      else result = out;
    });
  }
  #req(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  getExercises() { return this.#run("exercises", "readonly", (tx) => this.#req(tx.objectStore("exercises").getAll())); }
  saveExercise(e) { return this.#run("exercises", "readwrite", (tx) => { tx.objectStore("exercises").put(e); }); }
  deleteExercise(id) {
    return this.#run(["exercises", "photos"], "readwrite", (tx) => { tx.objectStore("exercises").delete(id); tx.objectStore("photos").delete(id); });
  }

  getPhotos() { return this.#run("photos", "readonly", (tx) => this.#req(tx.objectStore("photos").getAll())); }
  getPhoto(id) { return this.#run("photos", "readonly", (tx) => this.#req(tx.objectStore("photos").get(id))); }
  savePhoto(photo) { return this.#run("photos", "readwrite", (tx) => { tx.objectStore("photos").put(photo); }); }
  deletePhoto(id) { return this.#run("photos", "readwrite", (tx) => { tx.objectStore("photos").delete(id); }); }

  async getWorkouts() { return (await this.#run("workouts", "readonly", (tx) => this.#req(tx.objectStore("workouts").getAll()))).sort(byStart); }
  getWorkout(id) { return this.#run("workouts", "readonly", (tx) => this.#req(tx.objectStore("workouts").get(id))); }
  saveWorkout(w) { return this.#run("workouts", "readwrite", (tx) => { tx.objectStore("workouts").put(w); }); }
  async deleteWorkout(id) {
    const sets = (await this.getSets()).filter((s) => s.workoutId === id);
    await this.#run(["workouts", "sets", "setSamples"], "readwrite", (tx) => {
      tx.objectStore("workouts").delete(id);
      for (const s of sets) { tx.objectStore("sets").delete(s.id); tx.objectStore("setSamples").delete(s.id); }
    });
  }

  saveSet(set, samples) {
    return this.#run(["sets", "setSamples"], "readwrite", (tx) => {
      tx.objectStore("sets").put(set);
      if (samples) tx.objectStore("setSamples").put({ setId: set.id, samples });
    });
  }
  updateSet(set) { return this.#run("sets", "readwrite", (tx) => { tx.objectStore("sets").put(set); }); }
  getSet(id) { return this.#run("sets", "readonly", (tx) => this.#req(tx.objectStore("sets").get(id))); }
  async getSets() { return (await this.#run("sets", "readonly", (tx) => this.#req(tx.objectStore("sets").getAll()))).sort(byStart); }
  async getSamples(id) { return (await this.#run("setSamples", "readonly", (tx) => this.#req(tx.objectStore("setSamples").get(id))))?.samples; }
  deleteSet(id) {
    return this.#run(["sets", "setSamples"], "readwrite", (tx) => { tx.objectStore("sets").delete(id); tx.objectStore("setSamples").delete(id); });
  }

  async getActive() { return (await this.#run("meta", "readonly", (tx) => this.#req(tx.objectStore("meta").get("activeWorkout"))))?.value ?? null; }
  setActive(value) { return this.#run("meta", "readwrite", (tx) => { tx.objectStore("meta").put({ key: "activeWorkout", value }); }); }
  clearActive() { return this.#run("meta", "readwrite", (tx) => { tx.objectStore("meta").delete("activeWorkout"); }); }
}
