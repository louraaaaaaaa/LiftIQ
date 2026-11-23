import { PHASE_NAMES, describeBattery, describeInfo } from "./protocol.js";
import { STATES } from "./session.js";
import { LAB } from "./raw-session.js";

const IDS = [
  "sensorStatus", "statusText", "batteryChip", "batteryChipFill", "batteryChipText",
  "browserNotice", "errorNotice", "errorText", "dismissErrorButton",
  "workoutPage", "historyPage", "sensorPage", "workoutTab", "historyTab", "sensorTab",
  "stateLabel", "phaseBadge", "repCount",
  "elapsedTime", "sessionMessage",
  "calibrationPanel", "calibrationTitle", "calibrationTime", "calibrationProgress", "calibrationFill",
  "calibrationNote", "calibrationActions", "continueSetButton", "retryCalibrationButton",
  "stopButton", "calibrationCancelRow", "calibrationCancelButton",
  "totalAccel", "dynamicAccel", "axisX", "axisY", "axisZ", "telemetryChart",
  "historyCount", "historyList", "storageNote", "legacyHistory", "legacyCount", "workoutHistory",
  "sensorName", "connectButton", "connectLabel", "calibrateButton",
  "bluetoothState", "streamState", "calibrationState", "firmwareInfo", "appVersion", "devBadge",
  "batteryLevelFill", "batteryValue", "batteryVoltage",
  "customSensorName", "sensorSettingsForm", "startThreshold", "reversalThreshold", "restThreshold",
  "saveSensorSettings", "settingsMessage",
  "debugPanel", "debugState", "debugCalibration", "debugRate", "debugCounts", "debugBattery", "debugAge", "debugHex",
  "labPage", "devToolsToggle", "creditsList", "devTools", "openLabButton", "labBackButton", "connPanel", "connPanelName", "connPanelDetail", "connPanelButton", "labStateLabel", "labIntro", "labExercise", "labLoad", "labRom", "labNotes",
  "labProgressPanel", "labProgressTitle", "labProgressValue", "labProgressBar", "labProgressFill", "labMessage",
  "labArmButton", "labStartButton", "labStopButton", "labDownloadButton", "labSaveButton", "labEraseButton",
  "labDiscardButton", "rawCount", "rawList",
  "restSetting", "stepSetting", "trainSettingsForm", "trainSettingsMessage", "exerciseMediaToggle",
];

const EXPECTED_CALIBRATION_MS = 5500;
const FIRMWARE_STATUS_NAMES = ["0 none", "1 calibrating", "2 calibrated", "3 failed"];
const STATE_LABELS = {
  [STATES.DISCONNECTED]: "NOT CONNECTED",
  [STATES.IDLE]: "READY",
  [STATES.CALIBRATING]: "CALIBRATING",
  [STATES.RECORDING]: "RECORDING",
  [STATES.PAUSED]: "PAUSED",
  [STATES.REVIEWING]: "REVIEW",
  [STATES.SAVING]: "SAVING",
};

export function collectElements() {
  return Object.fromEntries(IDS.map((id) => [id, document.getElementById(id)]));
}

export function formatElapsed(milliseconds) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function formatDate(isoDate) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(isoDate));
}

function formatDuration(milliseconds) {
  const seconds = Math.floor(milliseconds / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export class Views {
  constructor(elements) {
    this.el = elements;
    this.lastState = null;
    this.snapshot = null;
    this.reviewView = "question";
  }

  // ---- generic -----------------------------------------------------------
  showError(message) {
    this.el.errorText.textContent = message;
    this.el.errorNotice.hidden = !message;
  }

  showPage(name) {
    const pages = {
      workout: [this.el.workoutPage, this.el.workoutTab],
      history: [this.el.historyPage, this.el.historyTab],
      lab: [this.el.labPage, null],
      sensor: [this.el.sensorPage, this.el.sensorTab],
    };
    // The Lab is not a tab any more: it lives under Sensor > Developer tools, so Sensor stays highlighted.
    const selected = name === "lab" ? "sensor" : name;
    for (const [pageName, [page, tab]] of Object.entries(pages)) {
      page.hidden = pageName !== name;
      if (!tab) continue;
      tab.classList.toggle("is-selected", pageName === selected);
      if (pageName === selected) tab.setAttribute("aria-current", "page");
      else tab.removeAttribute("aria-current");
    }
  }

  // ---- session snapshot ----------------------------------------------------
  render(snap, { sensorName, database, connectionPending }) {
    const el = this.el;
    const previous = this.lastState;
    this.lastState = snap.state;
    this.snapshot = snap;
    const inSet = [STATES.CALIBRATING, STATES.RECORDING, STATES.PAUSED].includes(snap.state);

    document.body.classList.toggle("sensor-connected", snap.connected);
    document.body.dataset.state = snap.state;
    document.body.classList.toggle("is-recording", snap.state === STATES.RECORDING || snap.state === STATES.PAUSED);
    el.sensorStatus.classList.toggle("is-connected", snap.connected);
    el.statusText.textContent = this.#statusText(snap, sensorName, connectionPending);
    el.stateLabel.textContent = STATE_LABELS[snap.state] || snap.state.toUpperCase();
    el.sensorName.textContent = snap.connected ? sensorName : "Not connected";
    el.bluetoothState.textContent = snap.connected ? "Connected" : "Disconnected";
    el.calibrationState.textContent = !snap.connected
      ? "Not connected"
      : snap.state === STATES.CALIBRATING ? "Calibrating…"
      : snap.firmwareStatus === 2 ? "Calibrated"
      : snap.firmwareStatus === 3 ? "Calibration failed"
      : snap.firmwareStatus === 1 ? "Calibrating…"
      : "Not calibrated";

    if (snap.state === STATES.PAUSED) {
      el.phaseBadge.textContent = "PAUSED";
      el.phaseBadge.classList.remove("phase-active");
    } else if (snap.state === STATES.RECORDING) {
      el.phaseBadge.textContent = PHASE_NAMES[snap.phase] ?? "IDLE";
      el.phaseBadge.classList.toggle("phase-active", snap.phase !== 0);
    } else {
      el.phaseBadge.textContent = snap.state === STATES.CALIBRATING ? "CALIBRATING" : "IDLE";
      el.phaseBadge.classList.remove("phase-active");
    }
    if (snap.message) el.sessionMessage.textContent = snap.message;

    el.stopButton.textContent = snap.stopLabel === "Stop set" ? "STOP SET" : snap.stopLabel;
    el.stopButton.disabled = !snap.canStop;
    el.connectButton.disabled = connectionPending;
    el.connectLabel.textContent = connectionPending ? "Connecting…" : snap.connected ? "Disconnect" : "Connect sensor";
    el.connPanelButton.textContent = connectionPending ? "Connecting…" : snap.connected ? "Disconnect" : "Connect sensor";
    el.connPanelButton.disabled = connectionPending;
    el.connPanelName.textContent = snap.connected ? sensorName : "Sensor not connected";
    el.connPanelDetail.textContent = snap.connected ? " · connected" : " · turn Bluetooth on and press Connect";
    el.connectButton.classList.toggle("is-connected", snap.connected);
    el.calibrateButton.disabled = !snap.canStart;
    void database;
    const settingsLocked = inSet || snap.state === STATES.REVIEWING || snap.state === STATES.SAVING;
    for (const input of [el.customSensorName, el.startThreshold, el.reversalThreshold, el.restThreshold, el.saveSensorSettings]) {
      input.disabled = settingsLocked;
    }

    this.#renderCalibration(snap, previous);
    this.showError(snap.error);
    this.updateElapsed();
  }

  #statusText(snap, sensorName, connectionPending) {
    if (connectionPending) return "Connecting…";
    if (!snap.connected) return "Sensor not connected";
    if (snap.state === STATES.RECORDING) return `${sensorName} · recording`;
    if (snap.state === STATES.PAUSED) return `${sensorName} · paused`;
    if (snap.state === STATES.CALIBRATING) return "Calibrating sensor…";
    return `${sensorName} connected`;
  }

  #renderCalibration(snap, previous) {
    const el = this.el;
    const show = snap.state === STATES.CALIBRATING;
    el.calibrationPanel.hidden = !show;
    el.calibrationCancelRow.hidden = !(show && !snap.session); // calibrate-only has no STOP SET button
    if (!show) return;
    if (previous !== STATES.CALIBRATING) el.calibrationPanel.focus();
    const needsAction = snap.stalled;
    el.calibrationActions.hidden = !needsAction;
    el.continueSetButton.hidden = !snap.canContinue;
    el.calibrationTitle.textContent = needsAction
      ? "Calibration is taking longer than expected"
      : "Calibrating — keep the sensor still";
    el.calibrationNote.textContent = snap.message;
    this.updateCalibrationProgress();
  }

  updateCalibrationProgress(now = Date.now()) {
    const snap = this.snapshot;
    if (!snap || snap.state !== STATES.CALIBRATING || snap.calibrationStartedAt === null) return;
    const elapsed = now - snap.calibrationStartedAt;
    const fraction = snap.stalled ? 1 : Math.min(1, elapsed / EXPECTED_CALIBRATION_MS);
    const percent = Math.round(fraction * 100);
    this.el.calibrationFill.style.width = `${percent}%`;
    this.el.calibrationProgress.setAttribute("aria-valuenow", String(percent));
    this.el.calibrationTime.textContent = `${Math.min(99, Math.floor(elapsed / 1000))} s`;
  }

  updateElapsed(now = Date.now()) {
    const snap = this.snapshot;
    if (snap?.session?.startedAt && (snap.state === STATES.RECORDING || snap.state === STATES.PAUSED)) {
      this.el.elapsedTime.textContent = formatElapsed(now - new Date(snap.session.startedAt).getTime());
    } else if (snap?.state === STATES.IDLE || snap?.state === STATES.DISCONNECTED) {
      // keep the last value until the next set starts
    }
  }

  resetLive() {
    const el = this.el;
    el.totalAccel.innerHTML = "—<small> m/s²</small>";
    el.dynamicAccel.innerHTML = "—<small> m/s²</small>";
    el.axisX.textContent = "—";
    el.axisY.textContent = "—";
    el.axisZ.textContent = "—";
  }

  resetElapsed() {
    this.el.elapsedTime.textContent = "00:00";
  }

  showReading(reading) {
    const el = this.el;
    el.axisX.textContent = reading.ax.toFixed(2);
    el.axisY.textContent = reading.ay.toFixed(2);
    el.axisZ.textContent = reading.az.toFixed(2);
    el.totalAccel.innerHTML = `${reading.totalAccel.toFixed(2)}<small> m/s²</small>`;
    el.dynamicAccel.innerHTML = `${reading.dynamicAccel.toFixed(2)}<small> m/s²</small>`;
  }

  // ---- device status ---------------------------------------------------------
  renderDevice({ connected, lastTelemetryAt, batteryMillivolts, info = null }) {
    const el = this.el;
    el.firmwareInfo.textContent = connected ? describeInfo(info) : "Not connected";
    const fresh = lastTelemetryAt !== null && Date.now() - lastTelemetryAt < 3000;
    el.streamState.textContent = !connected ? "Waiting for connection" : fresh ? "Receiving data" : "No recent data";

    const battery = connected ? describeBattery(batteryMillivolts) : { kind: "disconnected" };
    let chip = "—";
    let value = "—%";
    let detail = "Sensor not connected";
    let width = 0;
    if (battery.kind === "waiting") detail = "Waiting for first sensor packet";
    if (battery.kind === "none") {
      chip = "No battery";
      value = "No battery";
      detail = battery.message;
    }
    if (battery.kind === "ok") {
      chip = `${battery.percent}%`;
      value = `${battery.percent}%`;
      detail = `${battery.volts.toFixed(2)} V (estimate)`;
      width = battery.percent;
    }
    el.batteryChipText.textContent = chip;
    el.batteryChipFill.style.width = `${width}%`;
    el.batteryChip.dataset.kind = battery.kind;
    el.batteryValue.textContent = value;
    el.batteryVoltage.textContent = detail;
    el.batteryLevelFill.style.width = `${width}%`;
  }

  renderDebug(stats, snap, batteryMillivolts) {
    const el = this.el;
    if (!el.debugPanel.open) return;
    el.debugState.textContent = snap.state;
    el.debugCalibration.textContent = snap.firmwareStatus === null
      ? "no packet yet"
      : FIRMWARE_STATUS_NAMES[snap.firmwareStatus] ?? String(snap.firmwareStatus);
    el.debugRate.textContent = `${stats.rateHz.toFixed(1)} Hz`;
    el.debugCounts.textContent = `${stats.total} / ${stats.dropped} / ${stats.invalid}`;
    el.debugBattery.textContent = batteryMillivolts === null
      ? "—"
      : `${batteryMillivolts} mV (pin ≈ ${Math.round(batteryMillivolts / 2)} mV)`;
    el.debugAge.textContent = stats.lastAgeMs === null ? "—" : `${(stats.lastAgeMs / 1000).toFixed(1)} s`;
    el.debugHex.textContent = stats.lastHex || "—";
  }

  // ---- Lab (raw capture) ----
  renderLab(snap, liveBusy) {
    const el = this.el;
    const labels = {
      [LAB.UNAVAILABLE]: "UNAVAILABLE", [LAB.IDLE]: "READY", [LAB.ARMING]: "ARMING", [LAB.ARMED]: "ARMED",
      [LAB.CAPTURING]: "RECORDING", [LAB.ON_DEVICE]: "ON SENSOR", [LAB.DOWNLOADING]: "DOWNLOADING",
      [LAB.DOWNLOADED]: "DOWNLOADED", [LAB.SAVING]: "SAVING", [LAB.ERROR]: "ERROR",
    };
    el.labStateLabel.textContent = labels[snap.state] || snap.state;
    el.labArmButton.disabled = !snap.canArm;
    el.labStartButton.disabled = !snap.canStart;
    el.labStopButton.disabled = !snap.canStop;
    el.labDownloadButton.disabled = !snap.canDownload;
    el.labSaveButton.disabled = !snap.canSave;
    el.labEraseButton.disabled = !snap.canErase;
    el.labDiscardButton.hidden = !snap.canDiscard;
    el.labDownloadButton.textContent = snap.state === LAB.ERROR || snap.progress.received > 0 ? "Resume download" : "Download";
    const formLocked = snap.state === LAB.ARMING || snap.state === LAB.CAPTURING || snap.state === LAB.SAVING;
    for (const input of [el.labExercise, el.labLoad, el.labRom, el.labNotes]) input.disabled = formLocked;
    if (!snap.connected) {
      el.labIntro.textContent = "Connect a sensor on the Sensor page to use the Lab.";
    } else if (!snap.supported) {
      el.labIntro.textContent = "Raw capture is not supported by this sensor firmware. Live set tracking works normally; flash the current firmware to use the Lab.";
    } else if (liveBusy) {
      el.labIntro.textContent = "A normal set is running. Finish it before using the Lab.";
    } else {
      el.labIntro.textContent = "Records raw accelerometer and gyroscope data (200 Hz) on the sensor, then downloads it for offline analysis. Hold still during Arm, press Start, do the set, press Stop.";
    }
    let title = "";
    let value = "";
    let percent = null;
    if (snap.state === LAB.ARMING) {
      title = "Hold the sensor still — calibrating";
      percent = snap.armPercent;
      value = `${percent}%`;
    } else if (snap.state === LAB.CAPTURING) {
      title = "Recording";
      percent = snap.capacitySamples ? Math.min(100, Math.round(snap.sampleCount * 100 / snap.capacitySamples)) : 0;
      value = `${(snap.sampleCount / 200).toFixed(1)} s / ${(snap.capacitySamples / 200).toFixed(0)} s`;
    } else if (snap.state === LAB.DOWNLOADING) {
      title = "Downloading from the sensor";
      const { received, total } = snap.progress;
      percent = total ? Math.round(received * 100 / total) : 0;
      value = total ? `${received} / ${total} chunks` : "starting…";
    }
    el.labProgressPanel.hidden = percent === null;
    if (percent !== null) {
      el.labProgressTitle.textContent = title;
      el.labProgressValue.textContent = value;
      el.labProgressFill.style.width = `${percent}%`;
      el.labProgressBar.setAttribute("aria-valuenow", String(percent));
    }
    const text = snap.error || snap.message || "";
    el.labMessage.textContent = snap.capacityReduced && !snap.error ? `${text} (capacity reduced by available memory)`.trim() : text;
  }

  renderRawList(records, { onDownload, onDelete }) {
    const el = this.el;
    el.rawCount.textContent = `${records.length} ${records.length === 1 ? "capture" : "captures"}`;
    el.rawList.replaceChildren();
    if (records.length === 0) {
      el.rawList.innerHTML = '<div class="empty-history"><strong>No raw captures yet</strong><span>Saved captures appear here with a CSV download. Put exported files in data/recordings/raw/.</span></div>';
      return;
    }
    for (const record of records) {
      const item = document.createElement("article");
      item.className = "history-item";
      const icon = document.createElement("span");
      icon.className = "history-icon";
      icon.textContent = String(record.repCountFirmware ?? "");
      icon.setAttribute("aria-label", `${record.repCountFirmware ?? 0} reps counted by the sensor`);
      const info = document.createElement("div");
      info.className = "history-info";
      const name = document.createElement("div");
      name.className = "history-name";
      name.textContent = record.exercise || "Raw capture";
      const details = document.createElement("div");
      details.className = "history-details";
      details.textContent = `${formatDate(record.createdAt)} · ${record.sampleCount} samples · ${record.durationS.toFixed(1)} s${record.loadKg !== "" ? ` · ${record.loadKg} kg` : ""}${record.knownRomCm !== "" ? ` · ROM ${record.knownRomCm} cm` : ""}`;
      info.append(name, details);
      const actions = document.createElement("div");
      actions.className = "history-actions";
      const exportButton = document.createElement("button");
      exportButton.type = "button";
      exportButton.className = "icon-button";
      exportButton.textContent = "↓ CSV";
      exportButton.setAttribute("aria-label", `Download raw CSV for ${record.exercise || "capture"}`);
      exportButton.addEventListener("click", () => onDownload(record));
      const removeButton = document.createElement("button");
      removeButton.type = "button";
      removeButton.className = "icon-button delete-button";
      removeButton.textContent = "Delete";
      removeButton.setAttribute("aria-label", `Delete raw capture ${record.exercise || ""}`);
      removeButton.addEventListener("click", () => onDelete(record));
      actions.append(exportButton, removeButton);
      item.append(icon, info, actions);
      el.rawList.append(item);
    }
  }

  // ---- history ---------------------------------------------------------------
  renderHistory(sessions, { onDownload, onDelete }) {
    const el = this.el;
    el.legacyCount.textContent = `${sessions.length} ${sessions.length === 1 ? "set" : "sets"}`;
    el.legacyHistory.hidden = sessions.length === 0;
    el.historyList.replaceChildren();
    if (sessions.length === 0) return;
    for (const saved of sessions) {
      const item = document.createElement("article");
      item.className = "history-item";
      const icon = document.createElement("span");
      icon.className = "history-icon";
      icon.textContent = String(saved.repCount);
      icon.setAttribute("aria-label", `${saved.repCount} reps`);
      const info = document.createElement("div");
      info.className = "history-info";
      const name = document.createElement("div");
      name.className = "history-name";
      name.textContent = saved.exercise || "Workout set";
      const details = document.createElement("div");
      details.className = "history-details";
      details.textContent = `${formatDate(saved.createdAt)} · ${saved.repCount} reps · ${formatDuration(saved.durationMs)} · ${saved.sampleCount} samples`;
      info.append(name, details);
      const actions = document.createElement("div");
      actions.className = "history-actions";
      const exportButton = document.createElement("button");
      exportButton.type = "button";
      exportButton.className = "icon-button";
      exportButton.textContent = "↓ CSV";
      exportButton.setAttribute("aria-label", `Download CSV for ${saved.exercise}`);
      exportButton.addEventListener("click", () => onDownload(saved));
      const removeButton = document.createElement("button");
      removeButton.type = "button";
      removeButton.className = "icon-button delete-button";
      removeButton.textContent = "Delete";
      removeButton.setAttribute("aria-label", `Delete ${saved.exercise}`);
      removeButton.addEventListener("click", () => onDelete(saved, removeButton));
      actions.append(exportButton, removeButton);
      item.append(icon, info, actions);
      el.historyList.append(item);
    }
  }
}
