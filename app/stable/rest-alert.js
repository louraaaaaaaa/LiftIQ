// End-of-rest alert: vibration + short WebAudio beep (both feature-detected; the visible flash is CSS).
// Browsers only allow audio after a user gesture, so prime() is called from button clicks.
export class RestAlert {
  constructor() { this.ctx = null; }

  prime() {
    try {
      const AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (!AudioContextClass) return;
      this.ctx ??= new AudioContextClass();
      if (this.ctx.state === "suspended") void this.ctx.resume();
    } catch { /* audio unavailable */ }
  }

  fire() {
    try { globalThis.navigator?.vibrate?.([220, 120, 220]); } catch { /* ignore */ }
    try {
      const ctx = this.ctx;
      if (!ctx || ctx.state !== "running") return;
      const now = ctx.currentTime;
      for (const [offset, freq] of [[0, 880], [0.22, 1175]]) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.0001, now + offset);
        gain.gain.exponentialRampToValueAtTime(0.25, now + offset + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + offset + 0.18);
        osc.connect(gain).connect(ctx.destination);
        osc.start(now + offset);
        osc.stop(now + offset + 0.2);
      }
    } catch { /* ignore */ }
  }
}
