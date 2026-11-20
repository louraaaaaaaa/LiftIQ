import {
  RAW_CHUNK,
  RAW_CMD,
  RAW_STATE,
  RawDownload,
  buildRawCsv,
  encodeRawCommand,
  parseRawInfo,
  parseRawStatus,
  parseRawStream,
} from "./raw-protocol.js";

// Lab ("research capture") state machine. No DOM, no Bluetooth: the ble client, storage and
// clock are injected so it is unit tested. The firmware keeps the captured data in RAM until
// ERASE, so a disconnect never loses data: the download can be resumed after reconnecting.

export const LAB = Object.freeze({
  UNAVAILABLE: "unavailable",
  IDLE: "idle",
  ARMING: "arming",
  ARMED: "armed",
  CAPTURING: "capturing",
  ON_DEVICE: "on-device",
  DOWNLOADING: "downloading",
  DOWNLOADED: "downloaded",
  SAVING: "saving",
  ERROR: "error",
});

const defaultClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (id) => globalThis.clearTimeout(id),
};

export class RawCaptureMachine {
  constructor({
    ble,
    storage,
    clock = defaultClock,
    uuid,
    log = () => {},
    canRun = () => true,
    idleTimeoutMs = 3000,
    maxRounds = 40,
    maxStalls = 4,
    maxRangeChunks = 500,
  } = {}) {
    this.ble = ble;
    this.storage = storage;
    this.clock = clock;
    this.uuid = uuid || (() => globalThis.crypto.randomUUID());
    this.log = log;
    this.canRun = canRun;
    this.idleTimeoutMs = idleTimeoutMs;
    this.maxRounds = maxRounds;
    this.maxStalls = maxStalls;
    this.maxRangeChunks = maxRangeChunks;

    this.supported = false;
    this.connected = false;
    this.fw = null;            // last firmware status
    this.download = null;      // RawDownload in progress / partial
    this.downloading = false;
    this.capture = null;       // parsed download (header + samples), not yet saved
    this.droppedChunks = 0;
    this.firstDoneSeen = false;
    this.rounds = 0;
    this.stalls = 0;
    this.autoDownload = false;
    this.saving = false;
    this.localError = "";
    this.message = "";
    this.lastSaved = null;
    this.timer = null;
    this.listeners = new Set();
    this.lastState = null;
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get state() {
    if (!this.supported) return LAB.UNAVAILABLE;
    if (this.saving) return LAB.SAVING;
    if (this.downloading) return LAB.DOWNLOADING;
    if (this.localError) return LAB.ERROR;
    if (this.capture) return LAB.DOWNLOADED;
    if (!this.connected) return LAB.UNAVAILABLE;
    const state = this.fw?.state;
    switch (state) {
      case RAW_STATE.ARMING: return LAB.ARMING;
      case RAW_STATE.ARMED: return LAB.ARMED;
      case RAW_STATE.CAPTURING: return LAB.CAPTURING;
      case RAW_STATE.READY:
      case RAW_STATE.UPLOADING: return LAB.ON_DEVICE;
      case RAW_STATE.ERROR: return LAB.ERROR;
      default: return LAB.IDLE;
    }
  }

  // Raw capture in progress: live sets must not start.
  get busy() {
    const s = this.state;
    return s === LAB.ARMING || s === LAB.ARMED || s === LAB.CAPTURING || s === LAB.DOWNLOADING;
  }

  snapshot() {
    const state = this.state;
    const connected = this.connected && this.supported;
    const run = connected && this.canRun();
    const total = this.download?.total ?? null;
    return {
      state,
      supported: this.supported,
      connected: this.connected,
      busy: this.busy,
      message: this.message,
      error: this.localError || (this.fw?.state === RAW_STATE.ERROR ? this.firmwareError() : ""),
      armPercent: this.fw?.armPercent ?? 0,
      sampleCount: this.fw?.sampleCount ?? 0,
      capacitySamples: this.fw?.capacitySamples ?? 0,
      capacityReduced: Boolean(this.fw?.capacityReduced),
      progress: { received: this.download?.received ?? 0, total },
      droppedChunks: this.droppedChunks,
      capture: this.capture,
      lastSaved: this.lastSaved,
      canArm: run && state === LAB.IDLE,
      canStart: run && state === LAB.ARMED,
      canStop: connected && (state === LAB.CAPTURING || state === LAB.ARMING),
      canDownload: run && (state === LAB.ON_DEVICE || (state === LAB.ERROR && Boolean(this.download))),
      canSave: state === LAB.DOWNLOADED,
      canErase: connected && (state === LAB.ON_DEVICE || state === LAB.ERROR || state === LAB.ARMED),
      canDiscard: state === LAB.DOWNLOADED,
    };
  }

  firmwareError() {
    return this.fw?.errorCode === 1 ? "The sensor has too little free memory for a capture." : "The sensor rejected the command in its current state.";
  }

  _emit() {
    const state = this.state;
    if (state !== this.lastState) {
      this.log(`[lab] ${this.lastState} -> ${state}`);
      this.lastState = state;
    }
    const snap = this.snapshot();
    for (const listener of [...this.listeners]) listener(snap);
  }

  _clearTimer() {
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    this.timer = null;
  }

  _armTimer() {
    this._clearTimer();
    this.timer = this.clock.setTimeout(() => this._onIdleTimeout(), this.idleTimeoutMs);
  }

  async _send(command, arg1, arg2) {
    try {
      await this.ble.writeRaw(encodeRawCommand(command, arg1, arg2));
      return true;
    } catch (error) {
      this.localError = `Command failed: ${error.message}`;
      this._emit();
      return false;
    }
  }

  // ---- connection ----------------------------------------------------------
  setSupported(supported) {
    this.supported = supported;
    this._emit();
  }

  bleConnected() {
    this.connected = true;
    this.fw = null;
    this.localError = "";
    if (this.download && !this.capture) {
      this.message = "Reconnected. The capture is still on the sensor - resume the download.";
    }
    this._emit();
  }

  bleDisconnected() {
    this.connected = false;
    this.fw = null;
    this._clearTimer();
    if (this.downloading) {
      this.downloading = false;
      this.message = "Connection lost during download. The capture stays on the sensor; reconnect and resume.";
    }
    this._emit();
  }

  // ---- incoming chunks --------------------------------------------------------
  onChunk(chunk) {
    if (!chunk) return;
    if (chunk.type === RAW_CHUNK.STATUS) {
      const status = parseRawStatus(chunk);
      if (status) this._onStatus(status);
      return;
    }
    if (!this.download || !this.downloading) return;
    if (chunk.type === RAW_CHUNK.INFO) {
      const info = parseRawInfo(chunk);
      if (info && this.download.setInfo(info)) this._afterProgress();
    } else if (chunk.type === RAW_CHUNK.DATA) {
      if (this.download.addChunk(chunk.index, chunk.payload)) {
        this.stalls = 0;
        this._armTimer();
      }
      this._afterProgress();
    } else if (chunk.type === RAW_CHUNK.DONE) {
      const info = parseRawInfo(chunk);
      if (info) this.download.setInfo(info);
      this._onDone();
    }
  }

  _onStatus(status) {
    // Capture ended (Stop pressed, or the sensor auto-stopped at its cap): download automatically.
    if (this.fw?.state === RAW_STATE.CAPTURING && status.state === RAW_STATE.READY) this.autoDownload = true;
    this.fw = status;
    if (status.state === RAW_STATE.READY && this.autoDownload && !this.download && !this.capture && status.sampleCount > 0) {
      this.autoDownload = false;
      void this.startDownload();
      return;
    }
    if (status.state === RAW_STATE.ERROR) this.autoDownload = false;
    this._emit();
  }

  _afterProgress() {
    if (this.download.complete) this._finishDownload();
    else this._emit();
  }

  _onDone() {
    const missing = this.download.missingRanges();
    if (missing === null) {
      void this._requestMissing();
      return;
    }
    if (!this.firstDoneSeen) {
      this.firstDoneSeen = true;
      this.droppedChunks = missing.reduce((sum, range) => sum + range.count, 0);
    }
    if (this.download.complete) this._finishDownload();
    else void this._requestMissing();
  }

  _onIdleTimeout() {
    this.timer = null;
    if (!this.downloading) return;
    this.stalls += 1;
    if (this.stalls > this.maxStalls) {
      this._failDownload("Download stalled. The capture is still on the sensor; check the connection and try again.");
      return;
    }
    void this._requestMissing();
  }

  async _requestMissing() {
    if (!this.downloading) return;
    this.rounds += 1;
    if (this.rounds > this.maxRounds) {
      this._failDownload(`Download incomplete after ${this.maxRounds} resend rounds. The capture is still on the sensor.`);
      return;
    }
    const ranges = this.download.missingRanges();
    this._armTimer();
    if (ranges === null) {
      // Never saw the info chunk: restart the upload.
      await this._send(RAW_CMD.DOWNLOAD);
    } else if (ranges.length === 0) {
      this._finishDownload();
    } else {
      const first = ranges[0];
      await this._send(RAW_CMD.RESEND, first.first, Math.min(first.count, this.maxRangeChunks));
    }
  }

  _failDownload(message) {
    this._clearTimer();
    this.downloading = false;
    this.localError = message;
    this._emit();
  }

  _finishDownload() {
    this._clearTimer();
    this.downloading = false;
    try {
      const parsed = parseRawStream(this.download.assemble());
      this.capture = parsed;
      this.message = `Downloaded ${parsed.samples.length} samples. Save the CSV.`;
    } catch (error) {
      this.localError = `Downloaded data could not be decoded: ${error.message}`;
    }
    this._emit();
  }

  // ---- UI commands -----------------------------------------------------------
  async arm() {
    if (!this.snapshot().canArm) return false;
    this.lastSaved = null;
    this.message = "Hold the sensor completely still while it calibrates (5 s).";
    return this._send(RAW_CMD.ARM);
  }

  async start() {
    if (!this.snapshot().canStart) return false;
    this.message = "Recording. Perform the set, then press Stop.";
    return this._send(RAW_CMD.START);
  }

  async stop() {
    if (!this.snapshot().canStop) return false;
    this.autoDownload = this.fw?.state === RAW_STATE.CAPTURING;
    this.message = "Stopped. Downloading the capture from the sensor...";
    return this._send(RAW_CMD.STOP);
  }

  async startDownload() {
    if (!this.snapshot().canDownload && !this.autoDownloadAllowed()) return false;
    this.localError = "";
    this.stalls = 0;
    this.rounds = 0;
    this.downloading = true;
    this.message = "Downloading from the sensor...";
    if (!this.download || !this.download.info) {
      this.download = new RawDownload();
      this.firstDoneSeen = false;
      this.droppedChunks = 0;
      this._armTimer();
      this._emit();
      return this._send(RAW_CMD.DOWNLOAD);
    }
    // Resume a partial download: only ask for the missing chunks.
    this._emit();
    await this._requestMissing();
    return true;
  }

  autoDownloadAllowed() {
    return this.connected && this.supported && this.fw?.state === RAW_STATE.READY && !this.capture;
  }

  async erase() {
    if (!this.snapshot().canErase) return false;
    this._clearTimer();
    this.download = null;
    this.downloading = false;
    this.capture = null;
    this.localError = "";
    this.message = "Capture erased from the sensor.";
    return this._send(RAW_CMD.ERASE);
  }

  discard() {
    if (!this.capture) return false;
    this.capture = null;
    this.download = null;
    this.message = "Capture discarded on the phone; it is still on the sensor until erased.";
    this._emit();
    return true;
  }

  clearError() {
    this.localError = "";
    this._emit();
  }

  async save(meta = {}) {
    if (!this.capture || this.saving) return null;
    this.saving = true;
    this._emit();
    const capturedAt = new Date(this.clock.now()).toISOString();
    const full = { ...meta, capturedAt, droppedChunks: this.droppedChunks };
    const { header, samples } = this.capture;
    const csv = buildRawCsv(this.capture, full);
    const record = {
      id: this.uuid(),
      createdAt: capturedAt,
      exercise: meta.exercise || "",
      loadKg: meta.loadKg ?? "",
      knownRomCm: meta.knownRomCm ?? "",
      notes: meta.notes || "",
      deviceName: meta.deviceName || "",
      sampleCount: samples.length,
      durationS: samples.length ? samples[samples.length - 1].t_s : 0,
      repCountFirmware: header.repCount,
      droppedChunks: this.droppedChunks,
      csv,
    };
    try {
      await this.storage.saveRaw(record);
    } catch (error) {
      this.saving = false;
      this.localError = `Could not save the capture: ${error.message}`;
      this._emit();
      return null;
    }
    this.saving = false;
    this.capture = null;
    this.download = null;
    this.lastSaved = record;
    this.message = "Saved. The sensor memory was erased.";
    this._emit();
    if (this.connected) {
      try { await this.ble.writeRaw(encodeRawCommand(RAW_CMD.ERASE)); } catch { /* data is saved; erase is best effort */ }
    }
    return record;
  }
}
