import {
  DEFAULT_REP_THRESHOLDS,
  LEGACY_DEVICE_NAME,
  encodeRepThresholds,
} from "./protocol.js";
import { PacketTracker } from "./packet-stats.js";
import { SessionMachine, STATES } from "./session.js";
import { BleClient } from "./ble.js";
import { SessionStorage, requestPersistentStorage } from "./storage.js";
import { SignalChart } from "./chart.js";
import { WakeLockManager } from "./wakelock.js";
import { Views, collectElements } from "./ui.js";

const SENSOR_SETTINGS_KEY = "liftiq-sensor-settings";

const elements = collectElements();
const views = new Views(elements);
const chart = new SignalChart(elements.telemetryChart);
const tracker = new PacketTracker();

let storage = null;
let connectionPending = false;
let lastTelemetryAt = null;
let batteryMillivolts = null;
let sensorSettings = { customName: "", thresholds: { ...DEFAULT_REP_THRESHOLDS } };

function sensorDisplayName() {
  return sensorSettings.customName || ble.name || LEGACY_DEVICE_NAME;
}

// ---- wiring ---------------------------------------------------------------
const ble = new BleClient({
  onPacket: handlePacket,
  onInvalidPacket: (dataView) => {
    tracker.recordInvalid(dataView);
    console.debug("[ble] invalid packet", dataView.byteLength, "bytes");
  },
  onDisconnect: handleDisconnect,
});

const machine = new SessionMachine({
  ble,
  storage: { save: (session) => (storage ? storage.save(session) : Promise.reject(new Error("Local storage is unavailable."))) },
  log: (message) => console.debug(message),
});

const wakeLock = new WakeLockManager({
  onUnavailable: (message) => { elements.sessionMessage.textContent = message; },
});

function handlePacket(reading, dataView) {
  const info = tracker.record(reading, dataView);
  lastTelemetryAt = Date.now();
  batteryMillivolts = reading.batteryMillivolts;
  views.showReading(reading);
  chart.push(reading.dynamicAccel);
  machine.onReading(reading, info);
  renderDevice();
}

function handleDisconnect() {
  tracker.reset();
  lastTelemetryAt = null;
  batteryMillivolts = null;
  machine.bleDisconnected();
  views.resetLive();
  renderDevice();
}

function render(snap = machine.snapshot()) {
  views.render(snap, { sensorName: sensorDisplayName(), database: Boolean(storage), connectionPending });
  wakeLock.setWanted(snap.state === STATES.RECORDING || snap.state === STATES.PAUSED);
}

function renderDevice() {
  views.renderDevice({ connected: machine.connected, lastTelemetryAt, batteryMillivolts });
}

machine.subscribe((snap) => {
  if (snap.state === STATES.CALIBRATING && elements.elapsedTime.textContent !== "00:00" && !snap.session?.startedAt) {
    views.resetElapsed();
  }
  render(snap);
});

// ---- connection -------------------------------------------------------------
async function connectSensor() {
  views.showError("");
  if (!BleClient.isSupported()) {
    views.showError("Web Bluetooth is not available in this browser. Use Chrome or Edge on your PC, or Chrome on Android. iPhone browsers are not supported.");
    return;
  }
  connectionPending = true;
  render();
  try {
    await ble.connect();
    tracker.reset();
    machine.bleConnected();
    try {
      await applyRepThresholds();
    } catch (error) {
      elements.settingsMessage.textContent = "Could not sync thresholds to the sensor.";
      views.showError(`Connected, but rep thresholds were not applied: ${error.message}`);
    }
  } catch (error) {
    if (error.name !== "NotFoundError") views.showError(`Could not connect: ${error.message}`);
  }
  connectionPending = false;
  render();
  renderDevice();
}

// ---- sensor settings -------------------------------------------------------
function loadSensorSettings() {
  let saved = null;
  try { saved = localStorage.getItem(SENSOR_SETTINGS_KEY); } catch { /* storage unavailable */ }
  if (saved) {
    try {
      const parsed = JSON.parse(saved);
      const thresholds = { ...DEFAULT_REP_THRESHOLDS, ...parsed.thresholds };
      encodeRepThresholds(thresholds);
      sensorSettings = {
        customName: typeof parsed.customName === "string" ? parsed.customName.slice(0, 32) : "",
        thresholds,
      };
    } catch (error) {
      views.showError(`Saved sensor settings could not be loaded: ${error.message}`);
    }
  }
  elements.customSensorName.value = sensorSettings.customName;
  elements.startThreshold.value = sensorSettings.thresholds.start;
  elements.reversalThreshold.value = sensorSettings.thresholds.reversal;
  elements.restThreshold.value = sensorSettings.thresholds.rest;
}

async function applyRepThresholds() {
  if (!ble.isConnected()) {
    elements.settingsMessage.textContent = "Saved on this device. Thresholds will sync when connected.";
    return;
  }
  await ble.sendThresholds(sensorSettings.thresholds);
  elements.settingsMessage.textContent = `Thresholds sent to ${sensorDisplayName()}.`;
}

async function saveSensorSettings(event) {
  event.preventDefault();
  const thresholds = {
    start: elements.startThreshold.valueAsNumber,
    reversal: elements.reversalThreshold.valueAsNumber,
    rest: elements.restThreshold.valueAsNumber,
  };
  try {
    const command = encodeRepThresholds(thresholds);
    sensorSettings = { customName: elements.customSensorName.value.trim(), thresholds };
    try { localStorage.setItem(SENSOR_SETTINGS_KEY, JSON.stringify(sensorSettings)); } catch { /* ignore */ }
    if (ble.isConnected()) {
      await ble.write(command);
      elements.settingsMessage.textContent = `Settings saved and sent to ${sensorDisplayName()}.`;
    } else {
      elements.settingsMessage.textContent = "Settings saved on this device and will sync when connected.";
    }
    render();
  } catch (error) {
    views.showError(`Could not save or apply sensor settings: ${error.message}`);
  }
}

// ---- history ----------------------------------------------------------------
function downloadCsv(saved) {
  const file = new Blob([saved.csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(file);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `liftiq-${saved.createdAt.slice(0, 10)}-${saved.id.slice(0, 8)}.csv`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function refreshHistory() {
  if (!storage) return;
  try {
    const sessions = await storage.getAll();
    views.renderHistory(sessions, {
      onDownload: downloadCsv,
      onDelete: async (saved) => {
        if (!window.confirm(`Delete "${saved.exercise}" and its saved CSV from this device?`)) return;
        try {
          await storage.delete(saved.id);
          await refreshHistory();
        } catch (error) {
          views.showError(error.message);
        }
      },
    });
  } catch (error) {
    views.showError(error.message);
  }
}

// ---- UI events --------------------------------------------------------------
elements.connectButton.addEventListener("click", () => {
  if (ble.isConnected()) ble.disconnect();
  else void connectSensor();
});
elements.startButton.addEventListener("click", async () => {
  views.showPage("workout");
  views.resetElapsed();
  views.resetLive();
  chart.clear();
  await machine.startSet({ exercise: elements.exerciseInput.value, sensorName: sensorDisplayName() });
});
elements.pauseButton.addEventListener("click", () => {
  if (machine.state === STATES.PAUSED) machine.resume();
  else machine.pause();
});
elements.stopButton.addEventListener("click", () => void machine.stop().then(() => {
  if (machine.state === STATES.IDLE) elements.startButton.focus();
}));
elements.retryCalibrationButton.addEventListener("click", () => void machine.retryCalibration());
elements.continueSetButton.addEventListener("click", () => machine.continueSet());
elements.calibrateButton.addEventListener("click", () => {
  views.showPage("workout");
  void machine.startSet({ calibrateOnly: true });
});
elements.dismissErrorButton.addEventListener("click", () => machine.clearError());
elements.workoutTab.addEventListener("click", () => { views.showPage("workout"); chart.schedule(); });
elements.historyTab.addEventListener("click", () => { views.showPage("history"); void refreshHistory(); });
elements.sensorTab.addEventListener("click", () => views.showPage("sensor"));
elements.setupSensorButton.addEventListener("click", () => {
  views.showPage("sensor");
  elements.connectButton.focus();
});
elements.sensorSettingsForm.addEventListener("submit", (event) => void saveSensorSettings(event));

elements.confirmRepsButton.addEventListener("click", () => {
  const session = machine.session;
  if (session) void machine.saveReview(session.repCount).then(afterSave);
});
elements.correctRepsButton.addEventListener("click", () => {
  elements.repReviewQuestion.hidden = true;
  elements.repCorrectionForm.hidden = false;
  elements.actualRepCount.focus();
});
elements.backToRepReviewButton.addEventListener("click", () => {
  elements.repCorrectionForm.hidden = true;
  elements.repReviewQuestion.hidden = false;
});
elements.repCorrectionForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const count = elements.actualRepCount.valueAsNumber;
  if (!Number.isInteger(count) || count < 0 || count > 999) {
    elements.actualRepCount.setCustomValidity("Enter a whole number from 0 to 999.");
    elements.actualRepCount.reportValidity();
    return;
  }
  elements.actualRepCount.setCustomValidity("");
  void machine.saveReview(count).then(afterSave);
});
elements.actualRepCount.addEventListener("input", () => elements.actualRepCount.setCustomValidity(""));
elements.finishReviewButton.addEventListener("click", () => {
  machine.dismissSaved();
  views.showPage("workout");
  elements.startButton.focus();
});
document.addEventListener("keydown", (event) => views.trapFocus(event));

async function afterSave(saved) {
  if (saved) await refreshHistory();
}

// ---- periodic UI refresh ------------------------------------------------------
setInterval(() => {
  const now = Date.now();
  views.updateElapsed(now);
  views.updateCalibrationProgress(now);
  renderDevice();
  views.renderDebug(tracker.snapshot(), machine.snapshot(), batteryMillivolts);
}, 500);
window.addEventListener("resize", () => chart.schedule());

// ---- startup ----------------------------------------------------------------
loadSensorSettings();

if (!window.isSecureContext) {
  elements.browserNotice.hidden = false;
  elements.browserNotice.textContent = "For Bluetooth and install support, open this app from an HTTPS address (not a local file).";
}
if (!BleClient.isSupported()) {
  elements.browserNotice.hidden = false;
  elements.browserNotice.textContent = "Bluetooth pairing is supported in Chrome on Android. iPhone browsers do not currently provide Web Bluetooth.";
}

try {
  storage = await SessionStorage.open();
  try {
    const persistent = await requestPersistentStorage();
    elements.storageNote.textContent = persistent
      ? "App storage is protected from automatic cleanup. Clearing browser/site data can still delete it."
      : "Saved on this device, but browser storage may be cleared. Download CSV backups to keep a separate copy.";
  } catch (error) {
    views.showError(`Could not check local storage retention: ${error.message}`);
  }
  await refreshHistory();
} catch (error) {
  views.showError(`Local app storage could not be opened: ${error.message}`);
}

render();
renderDevice();
chart.draw();

if ("serviceWorker" in navigator && window.isSecureContext) {
  navigator.serviceWorker.register("./sw.js").catch((error) => {
    views.showError(`Offline app setup failed: ${error.message}`);
  });
}
