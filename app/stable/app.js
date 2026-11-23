import { APP_VERSION, CHANNEL } from "./channel.js";
import {
  DEFAULT_REP_THRESHOLDS,
  LEGACY_DEVICE_NAME,
  encodeRepThresholds,
} from "./protocol.js";
import { PacketTracker } from "./packet-stats.js";
import { SessionMachine, STATES } from "./session.js";
import { RawCaptureMachine } from "./raw-session.js";
import { BleClient } from "./ble.js";
import { SessionStorage, requestPersistentStorage } from "./storage.js";
import { IdbWorkoutStorage, MemoryWorkoutStorage } from "./workout-storage.js";
import { PHASES, WorkoutMachine, sanitizeSettings } from "./workout.js";
import { SEED_EXERCISES, QUICK_EXERCISE, applyImageCredits, creditsEntries } from "./exercises.js";
import { buildLibrary, facets, filterExercises, leanExercise, loadExerciseIndex } from "./exercise-db.js";
import { isMediaEnabled, setMediaEnabled } from "./exercise-media.js";
import { TrainView, inlineConfirm } from "./train-view.js";
import { RestAlert } from "./rest-alert.js";
import { analyzeSet } from "./analysis/pulses.js";
import { describeInfo, describeBattery, NOTIFY_HZ } from "./protocol.js";
import { createStillnessDetector } from "./ready-check.js";
import { PhotoService } from "./photos.js";
import { isDevToolsEnabled, setDevToolsEnabled } from "./dev-tools.js";
import { buildSetCsv } from "./set-format.js";
import { SignalChart } from "./chart.js";
import { WakeLockManager } from "./wakelock.js";
import { Views, collectElements } from "./ui.js";

const SENSOR_SETTINGS_KEY = "liftiq-sensor-settings";
const TRAIN_SETTINGS_KEY = "liftiq-train-settings";

const elements = collectElements();
const views = new Views(elements);
const chart = new SignalChart(elements.telemetryChart);
const tracker = new PacketTracker();
const trainView = new TrainView();
const restAlert = new RestAlert();
const $ = (id) => document.getElementById(id);

let storage = null;
let workout = null;
let workoutStorage = null;
let customExercises = [];
let pendingWorkout = null;
let photos = null;
let datasetRecords = []; // compact dataset records (exercise-db), empty when the index could not be loaded
let datasetMeta = null;
let library = []; // custom + seeds + dataset
let mediaEnabled = isMediaEnabled();
const picker = { chip: "stack", bodyPart: "", target: "", equipment: "" };
let lastByCache = {};
let seedList = SEED_EXERCISES; // with default images once credits.json is loaded
const stillness = createStillnessDetector();
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
  onRawChunk: (chunk) => rawMachine.onChunk(chunk),
});

const machine = new SessionMachine({
  ble,
  storage: { save: (session) => (storage ? storage.save(session) : Promise.reject(new Error("Local storage is unavailable."))) },
  log: (message) => console.debug(message),
  isBlocked: () => rawMachine.busy,
});

const rawMachine = new RawCaptureMachine({
  ble,
  storage: { saveRaw: (record) => (storage ? storage.saveRaw(record) : Promise.reject(new Error("Local storage is unavailable."))) },
  log: (message) => console.debug(message),
  canRun: () => !liveSetActive(),
});

function liveSetActive() {
  return [STATES.CALIBRATING, STATES.RECORDING, STATES.PAUSED, STATES.REVIEWING, STATES.SAVING].includes(machine.state);
}

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
  // ready check: sensor time from the unwrapped sequence counter, arrival time for legacy packets
  const t = info.seq !== null && info.seq !== undefined ? info.seq / NOTIFY_HZ : Date.now() / 1000;
  workout?.setReadiness(stillness.push({ t, ax: reading.ax, ay: reading.ay, az: reading.az }));
  renderDevice();
}

function handleDisconnect() {
  tracker.reset();
  lastTelemetryAt = null;
  batteryMillivolts = null;
  machine.bleDisconnected();
  rawMachine.bleDisconnected();
  stillness.reset();
  workout?.setReadiness({ ready: false, still: false, stillS: 0, progress: 0 });
  views.resetLive();
  renderDevice();
}

function render(snap = machine.snapshot()) {
  views.render(snap, { sensorName: sensorDisplayName(), database: Boolean(storage), connectionPending });
  wakeLock.setWanted(snap.state === STATES.RECORDING || snap.state === STATES.PAUSED || rawMachine.busy || workout?.phase === PHASES.REST);
  renderTrain();
  views.renderLab(rawMachine.snapshot(), liveSetActive());
}

function batteryText() {
  const battery = describeBattery(batteryMillivolts);
  return battery.kind === "ok" ? `${battery.percent}%` : "";
}

function renderTrain() {
  if (!workout) return;
  trainView.render(workout.snapshot(), {
    connected: machine.connected, canStart: machine.snapshot().canStart && !rawMachine.busy,
    connecting: connectionPending, sensorName: sensorDisplayName(), batteryText: batteryText(),
  });
}

function renderDevice() {
  views.renderDevice({ connected: machine.connected, lastTelemetryAt, batteryMillivolts, info: ble.info });
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
    rawMachine.setSupported(ble.rawSupported);
    rawMachine.bleConnected();
    void ble.readRawStatus().then((chunk) => rawMachine.onChunk(chunk)).catch(() => {});
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
function downloadText(text, fileName) {
  const file = new Blob([text], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(file);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function downloadCsv(saved) {
  downloadText(saved.csv, `liftiq-${saved.createdAt.slice(0, 10)}-${saved.id.slice(0, 8)}.csv`);
}

function downloadRawCsv(record) {
  downloadText(record.csv, `liftiq-raw-${record.createdAt.slice(0, 10)}-${record.id.slice(0, 8)}.csv`);
}

async function downloadSet(set, fileName) {
  try {
    const samples = await workoutStorage.getSamples(set.id);
    downloadText(buildSetCsv(set, samples || []), fileName);
  } catch (error) {
    views.showError(`Could not export this set: ${error.message}`);
  }
}

function deleteSet(set, anchor) {
  inlineConfirm(anchor, "Really delete this set and its samples?", () => void doDeleteSet(set));
}

async function doDeleteSet(set) {
  try {
    await workoutStorage.deleteSet(set.id);
    const w = await workoutStorage.getWorkout(set.workoutId);
    if (w) {
      w.blocks = w.blocks.map((b) => ({ ...b, setIds: b.setIds.filter((id) => id !== set.id) })).filter((b) => b.setIds.length);
      if (w.blocks.length) await workoutStorage.saveWorkout(w);
      else await workoutStorage.deleteWorkout(w.id);
    }
    await refreshHistory();
    void refreshHome();
  } catch (error) {
    views.showError(error.message);
  }
}

async function refreshRawList() {
  if (!storage) return;
  try {
    views.renderRawList(await storage.getAllRaw(), {
      onDownload: downloadRawCsv,
      onDelete: async (record) => {
        if (!window.confirm(`Delete raw capture "${record.exercise || "capture"}" from this device?`)) return;
        try {
          await storage.deleteRaw(record.id);
          await refreshRawList();
        } catch (error) {
          views.showError(error.message);
        }
      },
    });
  } catch (error) {
    views.showError(error.message);
  }
}

async function refreshHistory() {
  if (!storage || !workoutStorage) return;
  try {
    trainView.renderWorkoutHistory(await workoutStorage.getWorkouts(), await workoutStorage.getSets(), {
      onDownload: downloadSet,
      onDelete: deleteSet,
      loadSamples: (id) => workoutStorage.getSamples(id),
      analyze: analyzeSet,
    });
    views.renderHistory(await storage.getAll(), {
      onDownload: downloadCsv,
      onDelete: (saved, anchor) => inlineConfirm(anchor, "Really delete this older set?", async () => {
        try {
          await storage.delete(saved.id);
          await refreshHistory();
        } catch (error) {
          views.showError(error.message);
        }
      }),
    });
  } catch (error) {
    views.showError(error.message);
  }
}

function renderCredits(credits) {
  const list = elements.creditsList;
  list.replaceChildren();
  for (const c of creditsEntries(credits)) {
    const li = document.createElement("li");
    const license = Object.assign(document.createElement("a"), { textContent: c.license, href: c.licenseUrl, target: "_blank", rel: "noopener noreferrer" });
    const source = Object.assign(document.createElement("a"), { textContent: "Wikimedia Commons", href: c.sourceUrl, target: "_blank", rel: "noopener noreferrer" });
    li.append(Object.assign(document.createElement("b"), { textContent: `\u201C${c.title}\u201D` }), ` by ${c.author}. `, source, " \u00B7 ", license, `. Used for: ${c.usedFor.join(", ")}. Modified: ${c.changes}`);
    list.append(li);
  }
}

// ---- train: exercise list ---------------------------------------------------------
async function refreshHome() {
  if (!workout) return;
  try { customExercises = await workoutStorage.getExercises(); } catch { customExercises = []; }
  customExercises.sort((x, y) => x.name.localeCompare(y.name));
  library = buildLibrary({ seeds: seedList, custom: customExercises, records: datasetRecords });
  try { lastByCache = await workout.lastByExercise(); } catch { lastByCache = {}; /* history unavailable */ }
  renderPicker();
}

function renderPicker() {
  const query = $("exerciseSearch").value;
  const filtering = Boolean(query.trim() || picker.bodyPart || picker.target || picker.equipment);
  const list = filterExercises(library, { ...picker, query, lastBy: lastByCache });
  const recent = filtering ? [] : library.filter((e) => lastByCache[e.id]).sort((a, b) => String(lastByCache[b.id].startedAt).localeCompare(String(lastByCache[a.id].startedAt))).slice(0, 4);
  trainView.setPhotos(photos?.map ?? new Map());
  trainView.setLibrary(library);
  trainView.setMedia({ enabled: mediaEnabled, sha: datasetMeta?.sha ?? null });
  trainView.setExercises(list, lastByCache, { recent });
  $("filterSummary").textContent = [picker.bodyPart, picker.target, picker.equipment].filter(Boolean).join(" · ");
}

function fillFilterOptions() {
  const f = facets(library);
  const fill = (id, values, current) => {
    const select = $(id);
    const keep = select.value || current;
    select.replaceChildren(Object.assign(document.createElement("option"), { value: "", textContent: "Any" }),
      ...values.map((v) => Object.assign(document.createElement("option"), { value: v, textContent: v[0].toUpperCase() + v.slice(1) })));
    select.value = values.includes(keep) ? keep : "";
  };
  fill("filterBodyPart", f.bodyParts, picker.bodyPart);
  fill("filterTarget", f.targets, picker.target);
  fill("filterEquipment", f.equipment, picker.equipment);
}

function loadTrainSettings() {
  let raw = null;
  try { raw = JSON.parse(localStorage.getItem(TRAIN_SETTINGS_KEY) || "null"); } catch { /* ignore */ }
  return sanitizeSettings(raw);
}

// ---- UI events --------------------------------------------------------------
elements.connectButton.addEventListener("click", () => {
  if (ble.isConnected()) ble.disconnect();
  else void connectSensor();
});
elements.stopButton.addEventListener("click", () => void workout?.stopSet());
elements.calibrationCancelButton.addEventListener("click", () => void machine.stop());
elements.retryCalibrationButton.addEventListener("click", () => void machine.retryCalibration());
elements.continueSetButton.addEventListener("click", () => machine.continueSet());
elements.calibrateButton.addEventListener("click", () => {
  views.showPage("workout");
  void machine.startSet({ calibrateOnly: true });
});
rawMachine.subscribe(() => render());
elements.labArmButton.addEventListener("click", () => void rawMachine.arm());
elements.labStartButton.addEventListener("click", () => void rawMachine.start());
elements.labStopButton.addEventListener("click", () => void rawMachine.stop());
elements.labDownloadButton.addEventListener("click", () => void rawMachine.startDownload());
elements.labEraseButton.addEventListener("click", () => {
  if (window.confirm("Erase the capture stored on the sensor? Download it first if you need it.")) void rawMachine.erase();
});
elements.labDiscardButton.addEventListener("click", () => {
  if (window.confirm("Discard the downloaded capture on this phone without saving?")) rawMachine.discard();
});
elements.labSaveButton.addEventListener("click", async () => {
  const record = await rawMachine.save({
    exercise: elements.labExercise.value,
    loadKg: elements.labLoad.value,
    knownRomCm: elements.labRom.value,
    notes: elements.labNotes.value,
    deviceName: ble.device?.name || ble.name,
  });
  if (record) {
    downloadRawCsv(record);
    await refreshRawList();
  }
});
elements.dismissErrorButton.addEventListener("click", () => machine.clearError());
elements.workoutTab.addEventListener("click", () => { views.showPage("workout"); chart.schedule(); });
elements.historyTab.addEventListener("click", () => { views.showPage("history"); void refreshHistory(); });
elements.sensorTab.addEventListener("click", () => views.showPage("sensor"));
elements.sensorSettingsForm.addEventListener("submit", (event) => void saveSensorSettings(event));

// ---- train events -------------------------------------------------------------------
const num = (id) => ($(id).value === "" ? null : Number($(id).value));
const toggleConnection = () => { if (ble.isConnected()) ble.disconnect(); else void connectSensor(); };
for (const id of ["homeConnectButton", "readyConnectButton", "connPanelButton"]) $(id).addEventListener("click", toggleConnection);
elements.sensorStatus.addEventListener("click", () => {
  const open = elements.connPanel.hidden;
  elements.connPanel.hidden = !open;
  elements.sensorStatus.setAttribute("aria-expanded", String(open));
});

// Browser/Android back button = one stage back (never leaves the app mid-workout, never loses data)
let lastStageKey = "machine";
let popping = false;
const stageKey = (snap) => (snap.phase === PHASES.SUMMARY ? "summary" : snap.stage);
function navBack() {
  if (history.state?.liftiq) history.back();
  else void workout.back();
}
window.addEventListener("popstate", async () => {
  if (!workout || workout.phase === PHASES.HOME) return;
  popping = true;
  const result = await workout.back();
  if (result === "confirm" || result === "stay") history.pushState({ liftiq: true, key: lastStageKey }, "");
  popping = false;
});

$("backButton").addEventListener("click", navBack);
$("confirmYes").addEventListener("click", () => void workout.answerConfirm(true));
$("confirmNo").addEventListener("click", () => void workout.answerConfirm(false));
let searchTimer = 0;
$("exerciseSearch").addEventListener("input", () => { clearTimeout(searchTimer); searchTimer = setTimeout(renderPicker, 120); });
for (const chip of $("pickerChips").querySelectorAll("[data-chip]")) {
  chip.addEventListener("click", () => {
    picker.chip = chip.dataset.chip;
    for (const c of $("pickerChips").querySelectorAll("[data-chip]")) c.setAttribute("aria-pressed", String(c === chip));
    renderPicker();
  });
}
for (const [id, key] of [["filterBodyPart", "bodyPart"], ["filterTarget", "target"], ["filterEquipment", "equipment"]]) {
  $(id).addEventListener("change", () => { picker[key] = $(id).value; renderPicker(); });
}
$("quickSetButton").addEventListener("click", () => { restAlert.prime(); void workout.selectExercise(QUICK_EXERCISE); });
function pickMachine(event) {
  if (event.target.closest("a")) return; // attribution links open the source, they do not pick the exercise
  const card = event.target.closest("[data-id]");
  if (!card) return;
  restAlert.prime();
  const exercise = library.find((e) => e.id === card.dataset.id);
  if (exercise) void workout.selectExercise(leanExercise(exercise));
}
$("exerciseList").addEventListener("click", pickMachine);
$("recentList").addEventListener("click", pickMachine);
$("customExerciseForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  restAlert.prime();
  const ok = await workout.selectCustom($("customExerciseName").value, "", [...customExercises, ...seedList]);
  if (ok) $("customExerciseName").value = "";
});
$("renameExerciseButton").addEventListener("click", () => void workout.renameExercise($("exerciseNameEdit").value));
$("weightMinus").addEventListener("click", () => workout.stepWeight(-1));
$("weightPlus").addEventListener("click", () => workout.stepWeight(1));
$("weightInput").addEventListener("input", () => workout.setWeight(num("weightInput")));
$("weightUnknownButton").addEventListener("click", () => { $("weightInput").value = ""; workout.setWeight(null); });
$("setNote").addEventListener("input", () => workout.setNote($("setNote").value));
$("continueButton").addEventListener("click", () => workout.continueToReady());
for (const id of ["changeMachineButton1", "changeMachineButton2", "changeMachineButton3"]) $(id).addEventListener("click", () => void workout.changeMachine());
$("removeMachineButton").addEventListener("click", () => {
  const exercise = workout.exercise;
  inlineConfirm($("removeMachineButton"), `Remove "${exercise.name}" and its photo from your list?`, async () => {
    await photos?.remove(exercise.id).catch(() => {});
    await workout.deleteCustomExercise(exercise.id);
    await workout.changeMachine();
    await refreshHome();
  });
});

// machine photos (own photos only, downscaled to <= 800 px JPEG, stored locally)
async function onPhotoChosen(input) {
  const file = input.files?.[0];
  input.value = "";
  if (!file || !workout.exercise || !photos) return;
  trainView.showPhotoMessage("Saving photo…");
  try {
    await photos.set(workout.exercise.id, file);
    trainView.showPhotoMessage("Photo saved on this device.");
  } catch (error) {
    trainView.showPhotoMessage(`Could not use this photo: ${error.message}`);
  }
  trainView.setPhotos(photos.map);
  renderTrain();
  void refreshHome();
}
$("takePhotoButton").addEventListener("click", () => $("photoCamera").click());
$("pickPhotoButton").addEventListener("click", () => $("photoGallery").click());
$("photoCamera").addEventListener("change", (event) => void onPhotoChosen(event.target));
$("photoGallery").addEventListener("change", (event) => void onPhotoChosen(event.target));
$("removePhotoButton").addEventListener("click", async () => {
  try { await photos.remove(workout.exercise.id); trainView.showPhotoMessage("Photo removed."); } catch (error) { trainView.showPhotoMessage(error.message); }
  trainView.setPhotos(photos.map);
  renderTrain();
  void refreshHome();
});

$("startSetButton").addEventListener("click", () => {
  restAlert.prime();
  views.resetElapsed();
  views.resetLive();
  chart.clear();
  void workout.startSet();
});
$("cancelSetButton").addEventListener("click", () => workout.requestConfirm("cancel-set"));
$("includeSetupToggle").addEventListener("change", () => workout.setIncludeSetup($("includeSetupToggle").checked));
$("reviewWeightMinus").addEventListener("click", () => workout.stepWeight(-1));
$("reviewWeightPlus").addEventListener("click", () => workout.stepWeight(1));
$("reviewWeightInput").addEventListener("input", () => workout.setWeight(num("reviewWeightInput")));
$("editCountButton").addEventListener("click", () => {
  trainView.showEditor($("repEditor").hidden, workout.snapshot().review?.count ?? 0);
});
$("repMinus").addEventListener("click", () => workout.stepCount(-1));
$("repPlus").addEventListener("click", () => workout.stepCount(1));
$("repEditInput").addEventListener("input", () => { const n = num("repEditInput"); if (n !== null) workout.editCount(n); });
$("confirmRepsButton").addEventListener("click", () => { restAlert.prime(); void workout.confirmSet(); });
$("discardSetButton").addEventListener("click", () => workout.requestConfirm("discard-set"));
$("restMinus").addEventListener("click", () => workout.shortenRest());
$("restPlus").addEventListener("click", () => workout.extendRest());
$("skipRestButton").addEventListener("click", () => workout.skipRest());
$("nextSetButton").addEventListener("click", () => void workout.nextSet());
$("finishExerciseButton").addEventListener("click", () => void workout.finishExercise());
$("addExerciseButton").addEventListener("click", () => void workout.addExercise());
async function finishWorkoutFlow() {
  await workout.finishWorkout();
  await refreshHistory();
  await refreshHome();
}
$("finishWorkoutButton").addEventListener("click", () => void finishWorkoutFlow());
$("finishWorkoutHomeButton").addEventListener("click", () => void finishWorkoutFlow());
$("resumeWorkoutButton").addEventListener("click", async () => {
  if (await workout.resume()) { pendingWorkout = null; trainView.renderResume(null); }
});
$("discardWorkoutButton").addEventListener("click", () => {
  $("resumeActions").hidden = true;
  $("resumeConfirm").hidden = false;
  $("discardWorkoutNo").focus();
});
$("discardWorkoutNo").addEventListener("click", () => {
  $("resumeConfirm").hidden = true;
  $("resumeActions").hidden = false;
  $("discardWorkoutButton").focus();
});
$("discardWorkoutYes").addEventListener("click", async () => {
  await workout.discardPending();
  pendingWorkout = null;
  $("resumeConfirm").hidden = true;
  $("resumeActions").hidden = false;
  trainView.renderResume(null);
});
elements.exerciseMediaToggle.checked = mediaEnabled;
elements.exerciseMediaToggle.addEventListener("change", () => {
  mediaEnabled = setMediaEnabled(elements.exerciseMediaToggle.checked);
  renderPicker();
  render();
});
elements.trainSettingsForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const settings = workout.updateSettings({ restS: elements.restSetting.valueAsNumber, stepKg: elements.stepSetting.valueAsNumber });
  try { localStorage.setItem(TRAIN_SETTINGS_KEY, JSON.stringify(settings)); } catch { /* ignore */ }
  elements.trainSettingsMessage.textContent = `Saved: rest ${settings.restS} s, weight step ${settings.stepKg} kg.`;
});
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") { workout?.tick(); renderTrain(); } });

// developer tools (Lab + debug): hidden unless switched on under Sensor
function applyDevTools(enabled) {
  elements.devToolsToggle.checked = enabled;
  elements.devTools.hidden = !enabled;
  if (!enabled && !elements.labPage.hidden) views.showPage("sensor");
}
elements.devToolsToggle.addEventListener("change", () => applyDevTools(setDevToolsEnabled(elements.devToolsToggle.checked)));
elements.openLabButton.addEventListener("click", () => { views.showPage("lab"); void refreshRawList(); });
elements.labBackButton.addEventListener("click", () => views.showPage("sensor"));
applyDevTools(isDevToolsEnabled());

// ---- periodic UI refresh ------------------------------------------------------
setInterval(() => {
  const now = Date.now();
  views.updateElapsed(now);
  views.updateCalibrationProgress(now);
  if (workout?.tick()) renderTrain();
  if (workout?.phase === PHASES.REST) trainView.renderRest(workout.snapshot());
  renderDevice();
  views.renderDebug(tracker.snapshot(), machine.snapshot(), batteryMillivolts);
}, 250);
window.addEventListener("resize", () => chart.schedule());

// ---- startup ----------------------------------------------------------------
document.documentElement.dataset.channel = CHANNEL;
elements.appVersion.textContent = `v${APP_VERSION}`;
if (elements.devBadge) elements.devBadge.hidden = CHANNEL !== "dev";
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
  workoutStorage = new IdbWorkoutStorage(storage.database);
} catch (error) {
  views.showError(`Local app storage could not be opened: ${error.message}. Sets will not be saved after you close the app.`);
}

const trainSettings = loadTrainSettings();
elements.restSetting.value = trainSettings.restS;
elements.stepSetting.value = trainSettings.stepKg;
workoutStorage ??= new MemoryWorkoutStorage();
workout = new WorkoutMachine({
  session: machine,
  storage: workoutStorage,
  settings: trainSettings,
  versions: { app: APP_VERSION, firmware: () => (ble.info ? describeInfo(ble.info) : "") },
  sensorName: sensorDisplayName,
  onRestDone: () => restAlert.fire(),
  log: (message) => console.debug(message),
});
photos = new PhotoService({ storage: workoutStorage });
try { // default machine images + credits (optional: pictograms are the fallback)
  const credits = await (await fetch("./assets/machines/credits.json")).json();
  seedList = applyImageCredits(SEED_EXERCISES, credits);
  renderCredits(credits);
} catch (error) {
  console.warn(`Machine image credits not loaded: ${error.message}`);
  elements.creditsList.innerHTML = "<li class=\"muted\">No images loaded.</li>";
}
try { // open exercise dataset index (optional: the seed machines work without it)
  const { meta, records } = await loadExerciseIndex();
  datasetRecords = records;
  datasetMeta = meta;
  const note = document.getElementById("datasetMeta");
  if (note) note.textContent = `${meta.count} exercises, dataset commit ${meta.sha.slice(0, 7)}.`;
} catch (error) {
  console.warn(`Exercise index not loaded: ${error.message}`);
}
library = buildLibrary({ seeds: seedList, custom: [], records: datasetRecords });
fillFilterOptions();
await photos.init().catch(() => {});
let lastWorkoutPhase = null;
workout.subscribe((snap) => {
  render();
  const key = stageKey(snap);
  if (key !== lastStageKey) {
    if (!popping && key !== "machine") history.pushState({ liftiq: true, key }, "");
    lastStageKey = key;
    if (key === "ready") chart.schedule();
  }
  document.body.dataset.stage = key;
  if (snap.phase !== lastWorkoutPhase) {
    if (snap.phase === PHASES.HOME) void refreshHome();
    if ([PHASES.REST, PHASES.SUMMARY].includes(snap.phase)) void refreshHistory();
    lastWorkoutPhase = snap.phase;
  }
});
try {
  pendingWorkout = await workout.pendingWorkout();
  trainView.renderResume(pendingWorkout);
  await refreshHome();
  if (storage) { await refreshHistory(); await refreshRawList(); }
} catch (error) {
  views.showError(`Could not load saved data: ${error.message}`);
}

render();
renderDevice();
chart.draw();

if ("serviceWorker" in navigator && window.isSecureContext) {
  // Offline caching is optional: a failure must never block the app with an error banner.
  navigator.serviceWorker.register("./sw.js").catch((error) => {
    console.warn(`Offline app setup failed: ${error.message}`);
  });
}

// Dev channel only: handle for manual UI tests in the browser (fake sensor packets). Not in stable.
if (CHANNEL === "dev") window.__liftiq = { workout, machine, stillness, rawMachine, views, trainView, photos, tracker };
