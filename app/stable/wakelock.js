// Screen Wake Lock held while a set is active. Feature-detected; failures are
// reported through onUnavailable (a non-blocking message) and never throw.
export class WakeLockManager {
  constructor({ onUnavailable = () => {} } = {}) {
    this.lock = null;
    this.wanted = false;
    this.onUnavailable = onUnavailable;
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && this.wanted) void this.#acquire();
    });
  }

  setWanted(wanted) {
    if (wanted === this.wanted) return;
    this.wanted = wanted;
    if (wanted) void this.#acquire();
    else this.#release();
  }

  async #acquire() {
    if (this.lock) return;
    if (!("wakeLock" in navigator)) {
      this.onUnavailable("This browser cannot keep the screen awake — keep it on manually.");
      return;
    }
    try {
      const lock = await navigator.wakeLock.request("screen");
      if (!this.wanted) {
        void lock.release().catch(() => {});
        return;
      }
      this.lock = lock;
      lock.addEventListener("release", () => { if (this.lock === lock) this.lock = null; });
    } catch (error) {
      this.lock = null;
      this.onUnavailable("The screen could not be kept awake — keep it on manually.");
    }
  }

  #release() {
    const lock = this.lock;
    this.lock = null;
    if (lock) void lock.release().catch(() => {});
  }
}
