import {
  createSessionCsv,
  decodeTelemetry,
  PHASE_NAMES,
  DEVICE_NAME,
  SERVICE_UUID,
  NOTIFY_UUID,
  WRITE_UUID,
} from "./protocol.js";

const DB_NAME = "liftiq-local";
const DB_VERSION = 1;
const STORE_NAME = "sessions";
const CALIBRATION_TIMEOUT_MS = 15000;
const MAX_CHART_POINTS = 240;
const chartValues = [];

const elements = Object.fromEntries(
  [
    "connectButton", "connectLabel", "sensorStatus", "statusText", "browserNotice",
    "errorNotice", "repCount", "phaseBadge", "totalAccel", "dynamicAccel",
    "velocity", "sampleRate", "axisX", "axisY", "axisZ", "telemetryChart",
    "exerciseInput", "elapsedTime", "startButton", "pauseButton", "stopButton",
    "sessionMessage", "historyCount", "historyList", "storageNote",
  ].map((id) => [id, document.getElementById(id)])
);

let database;
let device;
let notifyCharacteristic;
let writeCharacteristic;
let notificationsActive = false;
let captureState = "idle";
let session;
let calibrationTimer;
let lastCaptureTime;
let latestRepCount = 0;
let latestRate = null;
let connectionPending = false;
let chartFrame;
let elapsedTimer;

function setStatus(message, connected = Boolean(device?.gatt?.connected)) {
  elements.statusText.textContent = message;
  elements.sensorStatus.classList.toggle("is-connected", connected);
  elements.connectButton.classList.toggle("is-connected", connected);
  elements.connectLabel.textContent = connected ? "Disconnect" : "Connect sensor";
}

function showError(message) {
  elements.errorNotice.textContent = message;
  elements.errorNotice.hidden = false;
}

function clearError() {
  elements.errorNotice.hidden = true;
  elements.errorNotice.textContent = "";
}

function setMessage(message) {
  elements.sessionMessage.textContent = message;
}

async function enableNotifications() {
  if (!notifyCharacteristic) throw new Error("Connect to the sensor first.");
  if (notificationsActive) return;
  await notifyCharacteristic.startNotifications();
  notificationsActive = true;
}

async function disableNotifications() {
  if (!notificationsActive || !notifyCharacteristic || !device?.gatt?.connected) {
    notificationsActive = false;
    return;
  }
  await notifyCharacteristic.stopNotifications();
  notificationsActive = false;
}

function updateControls() {
  const connected = Boolean(device?.gatt?.connected);
  elements.connectButton.disabled = connectionPending;
  elements.connectLabel.textContent = connectionPending ? "Connecting…" : connected ? "Disconnect" : "Connect sensor";
  elements.startButton.disabled = !database || !connected || !["idle", "stopped"].includes(captureState);
  elements.pauseButton.disabled = !["recording", "paused"].includes(captureState);
  elements.pauseButton.textContent = captureState === "paused" ? "Resume" : "Pause";
  elements.stopButton.disabled = !["recording", "paused"].includes(captureState);
  elements.exerciseInput.disabled = ["calibrating", "recording", "paused"].includes(captureState);
}

function resetLiveValues() {
  elements.repCount.textContent = "0";
  elements.phaseBadge.textContent = "IDLE";
  elements.phaseBadge.classList.remove("phase-active");
  elements.totalAccel.innerHTML = "—<small> m/s²</small>";
  elements.dynamicAccel.innerHTML = "—<small> m/s²</small>";
  elements.velocity.innerHTML = "—<small> m/s</small>";
  elements.sampleRate.innerHTML = "—<small> Hz</small>";
  elements.axisX.textContent = "—";
  elements.axisY.textContent = "—";
  elements.axisZ.textContent = "—";
  chartValues.length = 0;
  drawChart();
}

function formatElapsed(milliseconds) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function updateElapsed() {
  if (session?.startedAt && ["recording", "paused"].includes(captureState)) {
    elements.elapsedTime.textContent = formatElapsed(Date.now() - session.startedAt);
  }
}

async function connectSensor() {
  clearError();
  if (!("bluetooth" in navigator)) {
    showError("Web Bluetooth is not available in this browser. Use Chrome or Edge on your PC, or Chrome on Android. iPhone browsers are not supported.");
    return;
  }

  connectionPending = true;
  updateControls();
  try {
    setStatus("Choose your LiftIQ sensor…", false);
    device = await navigator.bluetooth.requestDevice({
      filters: [{ name: DEVICE_NAME }, { services: [SERVICE_UUID] }],
      optionalServices: [SERVICE_UUID],
    });
    device.addEventListener("gattserverdisconnected", onDisconnected);
    setStatus(`Connecting to ${device.name || "sensor"}…`, false);
    const server = await device.gatt.connect();
    const service = await server.getPrimaryService(SERVICE_UUID);
    notifyCharacteristic = await service.getCharacteristic(NOTIFY_UUID);
    writeCharacteristic = await service.getCharacteristic(WRITE_UUID);
    notifyCharacteristic.addEventListener("characteristicvaluechanged", onTelemetry);
    await enableNotifications();
    connectionPending = false;
    setStatus(device.name || "Sensor connected", true);
    setMessage("Ready when you are. Start a set to calibrate the sensor.");
  } catch (error) {
    if (device?.gatt?.connected) device.gatt.disconnect();
    device = null;
    notificationsActive = false;
    notifyCharacteristic = null;
    writeCharacteristic = null;
    connectionPending = false;
    if (error.name !== "NotFoundError") {
      showError(`Could not connect: ${error.message}`);
    }
    setStatus("Sensor not connected", false);
  }
  updateControls();
}

function disconnectSensor() {
  if (device?.gatt?.connected) {
    device.gatt.disconnect();
  } else {
    onDisconnected();
  }
}

function onDisconnected() {
  clearTimeout(calibrationTimer);
  device = null;
  notificationsActive = false;
  notifyCharacteristic = null;
  writeCharacteristic = null;
  if (["recording", "paused", "calibrating"].includes(captureState)) {
    if (captureState !== "calibrating") {
      void stopSession("Sensor disconnected; captured data was saved.");
    } else {
      captureState = "idle";
      session = null;
      setMessage("Connection lost during calibration. Reconnect and try again.");
    }
  }
  setStatus("Sensor not connected", false);
  updateControls();
}

async function startSession() {
  if (!writeCharacteristic || !device?.gatt?.connected) return;
  clearError();
  session = {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    startedAt: null,
    exercise: elements.exerciseInput.value.trim() || "Workout set",
    samples: [],
    repCount: 0,
  };
  latestRepCount = 0;
  lastCaptureTime = null;
  latestRate = null;
  resetLiveValues();
  captureState = "calibrating";
  setMessage("Calibrating — keep the sensor still…");
  setStatus("Calibrating sensor…", true);
  updateControls();

  try {
    await enableNotifications();
    await writeCharacteristic.writeValue(new Uint8Array([0x01]));
    calibrationTimer = setTimeout(() => {
      if (captureState === "calibrating") {
        captureState = "idle";
        setMessage("Calibration timed out. Keep the sensor still and try again.");
        setStatus(
          device?.gatt?.connected ? `${device.name || "Sensor"} connected` : "Sensor not connected",
          Boolean(device?.gatt?.connected)
        );
        showError("No calibration response from the sensor. Check the BLE connection and firmware.");
        updateControls();
      }
    }, CALIBRATION_TIMEOUT_MS);
  } catch (error) {
    captureState = "idle";
    setMessage("Could not start calibration.");
    setStatus(
      device?.gatt?.connected ? `${device.name || "Sensor"} connected` : "Sensor not connected",
      Boolean(device?.gatt?.connected)
    );
    showError(`Start command failed: ${error.message}`);
    updateControls();
  }
}

async function togglePause() {
  if (captureState === "recording") {
    captureState = "paused";
    lastCaptureTime = null;
    latestRate = null;
    elements.phaseBadge.textContent = "PAUSED";
    elements.phaseBadge.classList.remove("phase-active");
    setMessage("Paused. Resume to continue logging this set.");
    setStatus(`${device?.name || "Sensor"} · paused`, true);
  } else if (captureState === "paused") {
    try {
      await enableNotifications();
      captureState = "recording";
      lastCaptureTime = null;
      latestRate = null;
      setMessage("Recording set data.");
      setStatus(`${device?.name || "Sensor"} · recording`, true);
    } catch (error) {
      showError(`Could not resume telemetry: ${error.message}`);
    }
  }
  updateControls();
}

async function stopSession(message = "Set saved on this device.") {
  if (!session) return;
  clearTimeout(calibrationTimer);
  captureState = "stopping";
  updateControls();
  try {
    await disableNotifications();
  } catch (error) {
    notificationsActive = false;
    showError(`Could not stop BLE notifications: ${error.message}`);
  }
  const stoppedAt = new Date();
  const startedAt = session.startedAt ? new Date(session.startedAt) : stoppedAt;
  const csv = createSessionCsv(session.samples);
  const savedSession = {
    ...session,
    stoppedAt: stoppedAt.toISOString(),
    durationMs: session.startedAt ? Math.max(0, stoppedAt.getTime() - startedAt.getTime()) : 0,
    repCount: latestRepCount,
    sampleCount: session.samples.length,
    csv,
  };
  try {
    await saveSession(savedSession);
  } catch (error) {
    captureState = "paused";
    setMessage("Could not save set history. Check available storage and tap Stop to retry.");
    showError(`Set data is still in memory but was not saved: ${error.message}`);
    setStatus(
      device?.gatt?.connected ? `${device.name || "Sensor"} · paused` : "Sensor not connected",
      Boolean(device?.gatt?.connected)
    );
    updateControls();
    return;
  }
  captureState = "stopped";
  session = null;
  elements.elapsedTime.textContent = formatElapsed(savedSession.durationMs);
  elements.phaseBadge.textContent = "STOPPED";
  elements.phaseBadge.classList.remove("phase-active");
  setMessage(message);
  setStatus(
    device?.gatt?.connected ? `${device.name || "Sensor"} connected` : "Sensor not connected",
    Boolean(device?.gatt?.connected)
  );
  await renderHistory();
  updateControls();
}

function handleCalibration(status) {
  if (captureState !== "calibrating") return;
  if (status === "started") {
    setMessage("Calibrating — keep the sensor still…");
    return;
  }
  if (status === "failed") {
    clearTimeout(calibrationTimer);
    captureState = "idle";
    setMessage("Calibration failed. Check the sensor and try again.");
    setStatus(
      device?.gatt?.connected ? `${device.name || "Sensor"} connected` : "Sensor not connected",
      Boolean(device?.gatt?.connected)
    );
    showError("The sensor could not complete its calibration.");
    updateControls();
    return;
  }
  if (status === "complete") {
    clearTimeout(calibrationTimer);
    session.startedAt = new Date().toISOString();
    captureState = "recording";
    elements.elapsedTime.textContent = "00:00";
    setMessage("Calibration complete. Recording your set.");
    setStatus(device?.name ? `${device.name} · recording` : "Sensor connected · recording", true);
    updateControls();
  }
}

function onTelemetry(event) {
  if (["stopping", "stopped"].includes(captureState)) return;
  const reading = decodeTelemetry(event.target.value);
  if (!reading) {
    showError("Received an invalid telemetry packet from the sensor.");
    return;
  }
  if (reading.calibration) {
    handleCalibration(reading.calibration);
    return;
  }

  if (captureState === "paused") {
    latestRepCount = reading.repCount;
    elements.repCount.textContent = String(reading.repCount);
    return;
  }

  latestRepCount = reading.repCount;
  elements.repCount.textContent = String(reading.repCount);
  elements.phaseBadge.textContent = PHASE_NAMES[reading.phase];
  elements.phaseBadge.classList.toggle("phase-active", reading.phase !== 0);
  elements.axisX.textContent = reading.ax.toFixed(2);
  elements.axisY.textContent = reading.ay.toFixed(2);
  elements.axisZ.textContent = reading.az.toFixed(2);
  elements.totalAccel.innerHTML = `${reading.totalAccel.toFixed(2)}<small> m/s²</small>`;
  elements.dynamicAccel.innerHTML = `${reading.dynamicAccel.toFixed(2)}<small> m/s²</small>`;
  elements.velocity.innerHTML = `${reading.velocity.toFixed(2)}<small> m/s</small>`;

  const now = performance.now();
  if (lastCaptureTime !== null) {
    const delta = now - lastCaptureTime;
    if (delta > 0) latestRate = 1000 / delta;
  }
  if (captureState === "recording" && session?.startedAt) {
    const elapsed = (Date.now() - new Date(session.startedAt).getTime()) / 1000;
    session.samples.push({
      elapsed_s: Number(elapsed.toFixed(3)),
      ax_m_s2: reading.ax,
      ay_m_s2: reading.ay,
      az_m_s2: reading.az,
      total_accel_m_s2: reading.totalAccel,
      dynamic_accel_m_s2: reading.dynamicAccel,
      velocity_estimate_m_s: reading.velocity,
      phase: PHASE_NAMES[reading.phase],
      phase_id: reading.phase,
      rep_count: reading.repCount,
      sample_rate_hz: latestRate === null ? "" : Number(latestRate.toFixed(1)),
    });
    lastCaptureTime = now;
    session.repCount = reading.repCount;
    session.sampleCount = session.samples.length;
  }
  if (latestRate !== null) {
    elements.sampleRate.innerHTML = `${latestRate.toFixed(1)}<small> Hz</small>`;
  }

  chartValues.push({ accel: reading.dynamicAccel, speed: reading.velocity });
  if (chartValues.length > MAX_CHART_POINTS) chartValues.shift();
  scheduleChart();
  updateElapsed();
}

function saveSession(savedSession) {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).put(savedSession);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error("Could not save this set."));
    transaction.onabort = () => reject(transaction.error || new Error("Saving this set was cancelled."));
  });
}

function getAllSessions() {
  return new Promise((resolve, reject) => {
    const request = database.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).getAll();
    request.onsuccess = () => resolve(request.result.sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
    request.onerror = () => reject(request.error || new Error("Could not load set history."));
  });
}

function deleteSession(id) {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).delete(id);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error("Could not delete this set."));
  });
}

function formatDate(isoDate) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(isoDate));
}

function formatDuration(milliseconds) {
  const seconds = Math.floor(milliseconds / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function downloadCsv(savedSession) {
  const file = new Blob([savedSession.csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(file);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `liftiq-${savedSession.createdAt.slice(0, 10)}-${savedSession.id.slice(0, 8)}.csv`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function renderHistory() {
  try {
    const sessions = await getAllSessions();
    elements.historyCount.textContent = `${sessions.length} ${sessions.length === 1 ? "set" : "sets"} saved`;
    elements.historyList.replaceChildren();
    if (sessions.length === 0) {
      elements.historyList.innerHTML = '<div class="empty-history"><span class="empty-icon" aria-hidden="true">↗</span><strong>No sets yet</strong><span>Your saved workouts and CSV files will show up here.</span></div>';
      return;
    }
    for (const savedSession of sessions) {
      const item = document.createElement("article");
      item.className = "history-item";
      const icon = document.createElement("span");
      icon.className = "history-icon";
      icon.textContent = String(savedSession.repCount);
      icon.setAttribute("aria-label", `${savedSession.repCount} reps`);
      const info = document.createElement("div");
      info.className = "history-info";
      const name = document.createElement("div");
      name.className = "history-name";
      name.textContent = savedSession.exercise || "Workout set";
      const details = document.createElement("div");
      details.className = "history-details";
      details.textContent = `${formatDate(savedSession.createdAt)} · ${savedSession.repCount} reps · ${formatDuration(savedSession.durationMs)} · ${savedSession.sampleCount} samples`;
      info.append(name, details);
      const actions = document.createElement("div");
      actions.className = "history-actions";
      const exportButton = document.createElement("button");
      exportButton.type = "button";
      exportButton.className = "icon-button";
      exportButton.textContent = "↓ CSV";
      exportButton.setAttribute("aria-label", `Download CSV for ${savedSession.exercise}`);
      exportButton.addEventListener("click", () => downloadCsv(savedSession));
      const removeButton = document.createElement("button");
      removeButton.type = "button";
      removeButton.className = "icon-button delete-button";
      removeButton.textContent = "Delete";
      removeButton.setAttribute("aria-label", `Delete ${savedSession.exercise}`);
      removeButton.addEventListener("click", async () => {
        if (window.confirm(`Delete "${savedSession.exercise}" and its saved CSV from this device?`)) {
          try {
            await deleteSession(savedSession.id);
            await renderHistory();
          } catch (error) {
            showError(error.message);
          }
        }
      });
      actions.append(exportButton, removeButton);
      item.append(icon, info, actions);
      elements.historyList.append(item);
    }
  } catch (error) {
    showError(error.message);
  }
}

function drawChart() {
  const canvas = elements.telemetryChart;
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const scale = window.devicePixelRatio || 1;
  canvas.width = Math.round(rect.width * scale);
  canvas.height = Math.round(rect.height * scale);
  const context = canvas.getContext("2d");
  context.scale(scale, scale);
  const width = rect.width;
  const height = rect.height;
  const padding = { top: 9, right: 6, bottom: 8, left: 6 };
  const graphWidth = width - padding.left - padding.right;
  const graphHeight = height - padding.top - padding.bottom;
  context.clearRect(0, 0, width, height);
  context.strokeStyle = "rgba(151, 164, 151, .12)";
  context.lineWidth = 1;
  for (let line = 0; line < 4; line++) {
    const y = padding.top + graphHeight * line / 3;
    context.beginPath();
    context.moveTo(padding.left, y);
    context.lineTo(width - padding.right, y);
    context.stroke();
  }
  if (chartValues.length < 2) return;

  const drawSeries = (key, color) => {
    const maxMagnitude = Math.max(.5, ...chartValues.map((value) => Math.abs(value[key])));
    context.beginPath();
    context.strokeStyle = color;
    context.lineWidth = 1.8;
    context.lineJoin = "round";
    context.lineCap = "round";
    chartValues.forEach((value, index) => {
      const x = padding.left + graphWidth * index / (chartValues.length - 1);
      const y = padding.top + graphHeight * (1 - (value[key] / maxMagnitude + 1) / 2);
      if (index === 0) context.moveTo(x, y);
      else context.lineTo(x, y);
    });
    context.stroke();
  };
  drawSeries("accel", "#c5f36b");
  drawSeries("speed", "#8aa6ff");
}

function scheduleChart() {
  if (chartFrame) return;
  chartFrame = requestAnimationFrame(() => {
    chartFrame = null;
    drawChart();
  });
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore(STORE_NAME, { keyPath: "id" });
      store.createIndex("createdAt", "createdAt");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Local storage is unavailable."));
  });
}

async function requestPersistentStorage() {
  if (!navigator.storage?.persist) {
    elements.storageNote.textContent = "Saved on this device, but browser storage may be cleared. Download CSV backups to keep a separate copy.";
    return;
  }
  const isPersistent = await navigator.storage.persist();
  elements.storageNote.textContent = isPersistent
    ? "App storage is protected from automatic cleanup. Clearing browser/site data can still delete it."
    : "Saved on this device, but browser storage may be cleared. Download CSV backups to keep a separate copy.";
}

elements.connectButton.addEventListener("click", () => {
  if (device?.gatt?.connected) disconnectSensor();
  else void connectSensor();
});
elements.startButton.addEventListener("click", () => void startSession());
elements.pauseButton.addEventListener("click", togglePause);
elements.stopButton.addEventListener("click", () => void stopSession());
window.addEventListener("resize", scheduleChart);
setInterval(updateElapsed, 500);

if (!window.isSecureContext) {
  elements.browserNotice.hidden = false;
  elements.browserNotice.textContent = "For Bluetooth and install support, open this app from an HTTPS address (not a local file).";
}

if (!("bluetooth" in navigator)) {
  elements.browserNotice.hidden = false;
  elements.browserNotice.textContent = "Bluetooth pairing is supported in Chrome on Android. iPhone browsers do not currently provide Web Bluetooth.";
}

try {
  database = await openDatabase();
  try {
    await requestPersistentStorage();
  } catch (error) {
    showError(`Could not check local storage retention: ${error.message}`);
  }
  await renderHistory();
  updateControls();
} catch (error) {
  showError(`Local app storage could not be opened: ${error.message}`);
}

if ("serviceWorker" in navigator && window.isSecureContext) {
  navigator.serviceWorker.register("./sw.js").catch((error) => {
    showError(`Offline app setup failed: ${error.message}`);
  });
}

drawChart();
