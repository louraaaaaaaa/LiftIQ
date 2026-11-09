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
const COUNTDOWN_SETTING_KEY = "liftiq-countdown-seconds";
const chartValues = [];

const elements = Object.fromEntries(
  [
    "connectButton", "connectLabel", "sensorStatus", "statusText", "browserNotice",
    "errorNotice", "repCount", "phaseBadge", "totalAccel", "dynamicAccel",
    "axisX", "axisY", "axisZ", "telemetryChart",
    "exerciseInput", "elapsedTime", "startButton", "pauseButton", "stopButton",
    "sessionMessage", "historyCount", "historyList", "storageNote",
    "workoutTab", "sensorTab", "historyTab", "workoutPage", "sensorPage",
    "historyPage", "sensorName", "bluetoothState", "streamState",
    "calibrationState", "batteryLevelFill", "batteryValue", "batteryVoltage",
    "calibrateButton", "countdownSetting", "countdownDialog", "countdownNumber",
    "cancelCountdownButton", "repReviewDialog", "repReviewQuestion",
    "detectedRepCount", "confirmRepsButton", "correctRepsButton",
    "repCorrectionForm", "actualRepCount", "backToRepReviewButton",
    "repCelebration", "celebratedRepCount", "repSaveMessage",
    "finishReviewButton",
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
let countdownTimer;
let countdownRemaining = 0;
let latestRepCount = 0;
let connectionPending = false;
let chartFrame;
let elapsedTimer;
let lastTelemetryAt = null;
let batteryMillivolts = null;
let reviewSaveMessage = "Your set is saved on this device.";

function setStatus(message, connected = Boolean(device?.gatt?.connected)) {
  elements.statusText.textContent = message;
  elements.sensorStatus.classList.toggle("is-connected", connected);
  elements.sensorName.textContent = connected ? device?.name || "GymIQ Sensor" : "Not connected";
  elements.bluetoothState.textContent = connected ? "Connected" : "Disconnected";
  updateDeviceStatus();
}

function batteryPercentage(millivolts) {
  const curve = [
    [3300, 0], [3500, 5], [3600, 10], [3700, 20], [3800, 40],
    [3900, 60], [4000, 80], [4100, 90], [4200, 100],
  ];
  if (millivolts <= curve[0][0]) return 0;
  for (let index = 1; index < curve.length; index++) {
    const [upperVoltage, upperPercent] = curve[index];
    if (millivolts <= upperVoltage) {
      const [lowerVoltage, lowerPercent] = curve[index - 1];
      const fraction = (millivolts - lowerVoltage) / (upperVoltage - lowerVoltage);
      return Math.round(lowerPercent + fraction * (upperPercent - lowerPercent));
    }
  }
  return 100;
}

function updateDeviceStatus() {
  const connected = Boolean(device?.gatt?.connected);
  const streamFresh = lastTelemetryAt !== null && Date.now() - lastTelemetryAt < 3000;
  elements.streamState.textContent = !connected
    ? "Waiting for connection"
    : streamFresh ? "Receiving data" : "No recent data";
  elements.calibrationState.textContent = captureState === "calibrating" || captureState === "sensor-calibrating"
    ? "Calibrating…"
    : captureState === "recording" || captureState === "paused"
      ? "Calibrated for this set"
      : elements.calibrationState.dataset.calibrated === "true"
        ? "Calibrated"
        : "Not calibrated this session";
  if (batteryMillivolts === null) {
    elements.batteryValue.textContent = "—%";
    elements.batteryVoltage.textContent = connected ? "Waiting for sensor data" : "Sensor not connected";
    elements.batteryLevelFill.style.width = "0%";
    return;
  }
  const percentage = batteryPercentage(batteryMillivolts);
  elements.batteryValue.textContent = `${percentage}%`;
  elements.batteryVoltage.textContent = `${(batteryMillivolts / 1000).toFixed(2)} V`;
  elements.batteryLevelFill.style.width = `${percentage}%`;
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
  elements.connectButton.classList.toggle("is-connected", connected);
  elements.startButton.disabled = !database || !connected || !["idle", "stopped"].includes(captureState);
  elements.pauseButton.disabled = !["recording", "paused"].includes(captureState);
  elements.pauseButton.textContent = captureState === "paused" ? "Resume" : "Pause";
  elements.stopButton.disabled = !["recording", "paused"].includes(captureState);
  elements.exerciseInput.disabled = ["countdown", "calibrating", "recording", "paused", "stopping", "reviewing"].includes(captureState);
  elements.calibrateButton.disabled = !connected || !["idle", "stopped"].includes(captureState);
  updateDeviceStatus();
}

function resetLiveValues() {
  elements.repCount.textContent = "0";
  elements.phaseBadge.textContent = "IDLE";
  elements.phaseBadge.classList.remove("phase-active");
  elements.totalAccel.innerHTML = "—<small> m/s²</small>";
  elements.dynamicAccel.innerHTML = "—<small> m/s²</small>";
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
    elements.elapsedTime.textContent = formatElapsed(Date.now() - new Date(session.startedAt).getTime());
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
  clearInterval(countdownTimer);
  device = null;
  notificationsActive = false;
  notifyCharacteristic = null;
  writeCharacteristic = null;
  lastTelemetryAt = null;
  batteryMillivolts = null;
  elements.calibrationState.dataset.calibrated = "false";
  if (["recording", "paused"].includes(captureState)) {
    void stopSession("Sensor disconnected. Review the rep count to save captured data.");
  } else if (["countdown", "calibrating", "sensor-calibrating"].includes(captureState)) {
    elements.countdownDialog.hidden = true;
    captureState = "idle";
    session = null;
    setMessage("Connection lost before the set started. Reconnect and try again.");
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
  resetLiveValues();
  showPage("workout");
  const countdownSeconds = Number(elements.countdownSetting.value);
  if (countdownSeconds > 0) {
    captureState = "countdown";
    countdownRemaining = countdownSeconds;
    elements.countdownNumber.textContent = String(countdownRemaining);
    elements.countdownDialog.hidden = false;
    setMessage(`Starting in ${countdownRemaining} seconds. Get into position.`);
    updateControls();
    countdownTimer = setInterval(() => {
      countdownRemaining -= 1;
      if (countdownRemaining <= 0) {
        clearInterval(countdownTimer);
        elements.countdownDialog.hidden = true;
        void requestCalibration(true);
        return;
      }
      elements.countdownNumber.textContent = String(countdownRemaining);
      setMessage(`Starting in ${countdownRemaining} seconds. Get into position.`);
    }, 1000);
    return;
  }
  await requestCalibration(true);
}

async function requestCalibration(forSession) {
  if (!writeCharacteristic || !device?.gatt?.connected) return;
  captureState = forSession ? "calibrating" : "sensor-calibrating";
  elements.calibrationState.dataset.calibrated = "false";
  setMessage("Calibrating — keep the sensor still…");
  setStatus("Calibrating sensor…", true);
  updateControls();
  try {
    await enableNotifications();
    await writeCharacteristic.writeValue(new Uint8Array([0x01]));
    calibrationTimer = setTimeout(() => {
      if (["calibrating", "sensor-calibrating"].includes(captureState)) {
        captureState = "idle";
        session = null;
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
    session = null;
    setMessage("Could not start calibration.");
    setStatus(
      device?.gatt?.connected ? `${device.name || "Sensor"} connected` : "Sensor not connected",
      Boolean(device?.gatt?.connected)
    );
    showError(`Start command failed: ${error.message}`);
    updateControls();
  }
}

function cancelCountdown() {
  clearInterval(countdownTimer);
  elements.countdownDialog.hidden = true;
  captureState = "idle";
  session = null;
  setMessage("Start cancelled. Ready when you are.");
  updateControls();
}

async function togglePause() {
  if (captureState === "recording") {
    captureState = "paused";
    elements.phaseBadge.textContent = "PAUSED";
    elements.phaseBadge.classList.remove("phase-active");
    setMessage("Paused. Resume to continue logging this set.");
    setStatus(`${device?.name || "Sensor"} · paused`, true);
  } else if (captureState === "paused") {
    try {
      await enableNotifications();
      captureState = "recording";
      setMessage("Recording set data.");
      setStatus(`${device?.name || "Sensor"} · recording`, true);
    } catch (error) {
      showError(`Could not resume telemetry: ${error.message}`);
    }
  }
  updateControls();
}

async function stopSession(message = "Your set is saved on this device.") {
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
  session.stoppedAt = stoppedAt.toISOString();
  session.durationMs = session.startedAt
    ? Math.max(0, stoppedAt.getTime() - startedAt.getTime())
    : 0;
  session.repCount = latestRepCount;
  reviewSaveMessage = message;
  elements.detectedRepCount.textContent = String(latestRepCount);
  elements.actualRepCount.value = String(latestRepCount);
  elements.repReviewQuestion.hidden = false;
  elements.repCorrectionForm.hidden = true;
  elements.repCelebration.hidden = true;
  elements.repReviewDialog.hidden = false;
  captureState = "reviewing";
  setMessage("Review the detected rep count to finish saving this set.");
  setStatus(
    device?.gatt?.connected ? `${device.name || "Sensor"} connected` : "Sensor not connected",
    Boolean(device?.gatt?.connected)
  );
  updateControls();
}

async function saveReviewedSession(actualRepCount) {
  if (!session || captureState !== "reviewing") return;
  captureState = "saving";
  elements.confirmRepsButton.disabled = true;
  elements.correctRepsButton.disabled = true;
  elements.actualRepCount.disabled = true;
  updateControls();
  const savedSession = {
    ...session,
    repCount: actualRepCount,
    sensorRepCount: session.repCount,
    actualRepCount,
    repCountSource: actualRepCount === session.repCount ? "sensor-confirmed" : "user-corrected",
    sampleCount: session.samples.length,
    csv: createSessionCsv(session.samples.length === 0
      ? [{ actual_rep_count: actualRepCount }]
      : session.samples.map((sample) => ({
        ...sample,
        actual_rep_count: actualRepCount,
      }))),
  };
  try {
    await saveSession(savedSession);
  } catch (error) {
    captureState = "reviewing";
    elements.confirmRepsButton.disabled = false;
    elements.correctRepsButton.disabled = false;
    elements.actualRepCount.disabled = false;
    setMessage("Could not save set history. Check storage and retry saving the rep count.");
    showError(`Set data is still in memory but was not saved: ${error.message}`);
    setStatus(
      device?.gatt?.connected ? `${device.name || "Sensor"} connected` : "Sensor not connected",
      Boolean(device?.gatt?.connected)
    );
    updateControls();
    return;
  }
  captureState = "stopped";
  session = null;
  elements.confirmRepsButton.disabled = false;
  elements.correctRepsButton.disabled = false;
  elements.actualRepCount.disabled = false;
  elements.elapsedTime.textContent = formatElapsed(savedSession.durationMs);
  elements.phaseBadge.textContent = "STOPPED";
  elements.phaseBadge.classList.remove("phase-active");
  setMessage("Set saved on this device.");
  elements.repReviewQuestion.hidden = true;
  elements.repCorrectionForm.hidden = true;
  elements.repCelebration.hidden = false;
  elements.celebratedRepCount.textContent = String(actualRepCount);
  elements.repSaveMessage.textContent = reviewSaveMessage;
  elements.repCelebration.classList.remove("is-celebrating");
  void elements.repCelebration.offsetWidth;
  elements.repCelebration.classList.add("is-celebrating");
  setStatus(
    device?.gatt?.connected ? `${device.name || "Sensor"} connected` : "Sensor not connected",
    Boolean(device?.gatt?.connected)
  );
  await renderHistory();
  updateControls();
}

function handleCalibration(status) {
  if (!["calibrating", "sensor-calibrating"].includes(captureState)) return;
  if (status === "started") {
    elements.calibrationState.textContent = "Calibrating…";
    setMessage("Calibrating — keep the sensor still…");
    return;
  }
  if (status === "failed") {
    clearTimeout(calibrationTimer);
    captureState = "idle";
    session = null;
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
    elements.calibrationState.dataset.calibrated = "true";
    if (captureState === "sensor-calibrating") {
      captureState = "idle";
      setMessage("Calibration complete. The sensor is ready for your next set.");
      setStatus(`${device?.name || "Sensor"} connected`, true);
      updateControls();
      return;
    }
    session.startedAt = new Date().toISOString();
    captureState = "recording";
    elements.elapsedTime.textContent = "00:00";
    setMessage("Calibration complete. Recording your set.");
    setStatus(device?.name ? `${device.name} · recording` : "Sensor connected · recording", true);
    updateControls();
  }
}

function onTelemetry(event) {
  if (["stopping", "reviewing", "saving", "stopped"].includes(captureState)) return;
  const reading = decodeTelemetry(event.target.value);
  if (!reading) {
    showError("Received an invalid telemetry packet from the sensor.");
    return;
  }
  lastTelemetryAt = Date.now();
  if (reading.batteryMillivolts !== null && reading.batteryMillivolts > 0) {
    batteryMillivolts = reading.batteryMillivolts;
  }
  updateDeviceStatus();
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

  const now = performance.now();
  if (captureState === "recording" && session?.startedAt) {
    const elapsed = (Date.now() - new Date(session.startedAt).getTime()) / 1000;
    session.samples.push({
      elapsed_s: Number(elapsed.toFixed(3)),
      ax_m_s2: reading.ax,
      ay_m_s2: reading.ay,
      az_m_s2: reading.az,
      total_accel_m_s2: reading.totalAccel,
      dynamic_accel_m_s2: reading.dynamicAccel,
      phase: PHASE_NAMES[reading.phase],
      phase_id: reading.phase,
      rep_count: reading.repCount,
    });
    session.repCount = reading.repCount;
    session.sampleCount = session.samples.length;
  }

  chartValues.push({ accel: reading.dynamicAccel });
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

function showPage(name) {
  const pages = {
    workout: [elements.workoutPage, elements.workoutTab],
    sensor: [elements.sensorPage, elements.sensorTab],
    history: [elements.historyPage, elements.historyTab],
  };
  for (const [pageName, [page, tab]] of Object.entries(pages)) {
    page.hidden = pageName !== name;
    tab.classList.toggle("is-selected", pageName === name);
    if (pageName === name) tab.setAttribute("aria-current", "page");
    else tab.removeAttribute("aria-current");
  }
  if (name === "workout") scheduleChart();
}

elements.connectButton.addEventListener("click", () => {
  if (device?.gatt?.connected) disconnectSensor();
  else void connectSensor();
});
elements.startButton.addEventListener("click", () => void startSession());
elements.pauseButton.addEventListener("click", togglePause);
elements.stopButton.addEventListener("click", () => void stopSession());
elements.calibrateButton.addEventListener("click", () => void requestCalibration(false));
elements.cancelCountdownButton.addEventListener("click", cancelCountdown);
elements.workoutTab.addEventListener("click", () => showPage("workout"));
elements.sensorTab.addEventListener("click", () => showPage("sensor"));
elements.historyTab.addEventListener("click", () => showPage("history"));
elements.countdownSetting.value = localStorage.getItem(COUNTDOWN_SETTING_KEY) || "3";
elements.countdownSetting.addEventListener("change", () => {
  localStorage.setItem(COUNTDOWN_SETTING_KEY, elements.countdownSetting.value);
});
elements.confirmRepsButton.addEventListener("click", () => {
  if (session) void saveReviewedSession(session.repCount);
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
  void saveReviewedSession(count);
});
elements.actualRepCount.addEventListener("input", () => elements.actualRepCount.setCustomValidity(""));
elements.finishReviewButton.addEventListener("click", () => {
  elements.repReviewDialog.hidden = true;
  showPage("workout");
});
window.addEventListener("resize", scheduleChart);
setInterval(updateElapsed, 500);
setInterval(updateDeviceStatus, 1000);

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
