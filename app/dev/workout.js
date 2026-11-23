// Workout flow state machine (no DOM, no BLE). Drives one workout:
//   HOME (pick exercise) -> SETUP (weight) -> SET (calibrate + record, live counter)
//   -> REVIEW (pulse analysis, include/exclude setup pull, confirm/edit/discard)
//   -> REST (timestamp-based countdown) -> SETUP (next set) | SUMMARY (finish exercise)
//   -> HOME (add another exercise) | finish workout.
// The capture itself is the existing SessionMachine (calibration, 50 Hz recording, disconnect handling);
// this module only adds exercise/set bookkeeping, analysis and persistence on top of it.
import { analyzeSet } from "./analysis/pulses.js";
import { createLiveCounter } from "./analysis/live-counter.js";
import { STATES } from "./session.js";
import { QUICK_EXERCISE, customExercise } from "./exercises.js";
import { setLabel } from "./set-format.js";

export const PHASES = Object.freeze({
  HOME: "home", SETUP: "setup", SET: "set", REVIEW: "review", REST: "rest", SUMMARY: "summary",
});
export const STEPS = Object.freeze({ WEIGHT: "weight", READY: "ready" });
export const READY_FRESH_MS = 1500; // a readiness report older than this no longer counts
export const READY_HINT_MS = 5000; // show "machine moving?" hint after this long without stillness
export const CONFIRMS = Object.freeze({ CANCEL_SET: "cancel-set", DISCARD_SET: "discard-set" });
export const DEFAULT_SETTINGS = Object.freeze({ restS: 90, stepKg: 5 });
export const MAX_WEIGHT_KG = 999;
export const MAX_REPS = 999;
const REST_ADJUST_S = 15;
const MIN_REST_S = 0;

const round = (x, d) => (Number.isFinite(x) ? Number(x.toFixed(d)) : null);

export function sanitizeSettings(raw) {
  const restS = Number(raw?.restS);
  const stepKg = Number(raw?.stepKg);
  return {
    restS: Number.isFinite(restS) && restS >= 0 && restS <= 1800 ? Math.round(restS) : DEFAULT_SETTINGS.restS,
    stepKg: Number.isFinite(stepKg) && stepKg > 0 && stepKg <= 100 ? stepKg : DEFAULT_SETTINGS.stepKg,
    restByExercise: raw?.restByExercise && typeof raw.restByExercise === "object" ? { ...raw.restByExercise } : {},
  };
}

function pulseRecord(p) {
  return {
    n: p.n, t: round(p.t, 2), vPeak: round(p.vPeak, 3), upstrokeCm: round(p.upstrokeCm, 1),
    upstrokeS: round(p.upstrokeS, 2), timeToNextS: round(p.timeToNextS, 2), setup: Boolean(p.setup),
  };
}

function metricsRecord(m) {
  return {
    meanPeakVelocity: round(m.meanPeakVelocity, 3), velocityLossPct: round(m.velocityLossPct, 1),
    meanUpstrokeCm: round(m.meanUpstrokeCm, 1), meanRepPeriodS: round(m.meanRepPeriodS, 2),
    repPeriodTrend: round(m.repPeriodTrend, 3),
  };
}

/** Rows for the exercise summary table. */
export function summaryRows(sets) {
  return [...sets].sort((a, b) => a.setNumber - b.setNumber).map((s) => ({
    setNumber: s.setNumber, weightKg: s.weightKg, reps: s.repsConfirmed,
    meanPeakVelocity: s.metrics?.meanPeakVelocity ?? null,
    velocityLossPct: s.metrics?.velocityLossPct ?? null,
    meanRepPeriodS: s.metrics?.meanRepPeriodS ?? null,
  }));
}

/**
 * W3 HOOK: everything an exercise report needs, as plain data. `sets` are the saved set records of
 * the block, `samplesBySetId` optionally maps set id -> stored samples (adds the plotting series).
 */
export function buildExerciseReportData(block, sets, samplesBySetId = {}) {
  const ordered = [...sets].sort((a, b) => a.setNumber - b.setNumber);
  return {
    blockId: block.id, exerciseId: block.exerciseId, exerciseName: block.exerciseName,
    startedAt: block.startedAt, endedAt: block.endedAt ?? null,
    sets: ordered.map((s) => {
      const samples = samplesBySetId[s.id];
      let series = null;
      if (samples?.length) {
        const a = analyzeSet(samples, { includeSetupPull: s.setupPullIncluded });
        series = a.series;
      }
      return {
        id: s.id, setNumber: s.setNumber, weightKg: s.weightKg, label: setLabel(s), startedAt: s.startedAt,
        durationS: s.durationS, reps: s.repsConfirmed, repsSource: s.repsSource,
        repsDetectedWithSetup: s.repsDetectedWithSetup, repsDetectedExcludingSetup: s.repsDetectedExcludingSetup,
        setupPullFlagged: s.setupPullFlagged, setupPullIncluded: s.setupPullIncluded,
        pulses: s.pulses, metrics: s.metrics, restS: s.restS, note: s.note, series,
      };
    }),
    summary: summaryRows(ordered),
  };
}

export class WorkoutMachine {
  constructor({
    session, storage, clock = { now: () => Date.now() }, uuid = () => globalThis.crypto.randomUUID(),
    settings = DEFAULT_SETTINGS, versions = {}, sensorName = () => "", analyze = analyzeSet,
    createCounter = createLiveCounter, onRestDone = () => {}, log = () => {}, calibrate = false,
  }) {
    Object.assign(this, { session, storage, clock, uuid, versions, sensorName, analyze, createCounter, onRestDone, log, calibrate });
    this.settings = sanitizeSettings(settings);
    this.phase = PHASES.HOME;
    this.step = STEPS.WEIGHT; // sub-stage of SETUP
    this.confirm = null; // pending inline confirmation (CONFIRMS.*)
    this.arming = false; // Start pressed, waiting for stillness
    this._readiness = { ready: false, still: false, stillS: 0, progress: 0, at: 0 };
    this._readyEnteredAt = 0;
    this.exercise = null;
    this.workout = null;
    this.block = null;
    this.sets = [];
    this.weightKg = null; // null = unknown (optional, never blocks saving)
    this.note = "";
    this.setNumber = 1;
    this.live = { count: 0, ready: false };
    this.review = null;
    this.rest = null;
    this.lastSet = null;
    this.error = "";
    this.message = "";
    this.listeners = new Set();
    this._counter = null;
    this._fed = 0;
    this._seenActive = false;
    this._taking = false;
    session.subscribe((snap) => this._onSession(snap));
  }

  // ---- observation ---------------------------------------------------------
  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  _emit() { const snap = this.snapshot(); for (const l of [...this.listeners]) l(snap); }

  restRemainingS(now = this.clock.now()) {
    if (!this.rest) return 0;
    return Math.max(0, Math.ceil((this.rest.endsAt - now) / 1000));
  }

  snapshot() {
    const review = this.review;
    return {
      phase: this.phase, step: this.step, stage: this.stage(), confirm: this.confirm, arming: this.arming,
      readiness: this.readiness(), readyHint: this.readyHint(), canGoBack: this.phase !== PHASES.HOME,
      exercise: this.exercise, workout: this.workout, block: this.block, sets: this.sets,
      weightKg: this.weightKg, note: this.note, setNumber: this.setNumber, stepKg: this.settings.stepKg,
      live: { ...this.live }, session: this.session.snapshot(), lastSet: this.lastSet,
      error: this.error, message: this.message,
      review: review && {
        analysis: review.analysis, flagged: review.flagged, includeSetup: review.includeSetup,
        repsWithSetup: review.repsWithSetup, repsExcludingSetup: review.repsExcludingSetup,
        count: review.count, detected: review.detected, edited: review.edited, saving: Boolean(review.saving),
        durationS: review.meta.durationS, sampleCount: review.meta.sampleCount,
      },
      rest: this.rest && { ...this.rest, remainingS: this.restRemainingS() },
      summary: this.phase === PHASES.SUMMARY ? summaryRows(this.sets) : null,
    };
  }

  /** Stage for the stepper: machine > weight > ready > set > review > rest. */
  stage() {
    switch (this.phase) {
      case PHASES.HOME: return "machine";
      case PHASES.SETUP: return this.step;
      case PHASES.SET: return "set";
      case PHASES.REVIEW: return "review";
      default: return "rest";
    }
  }

  readiness() {
    const r = this._readiness;
    const fresh = this.clock.now() - r.at <= READY_FRESH_MS;
    return { still: fresh && r.still, stillS: fresh ? r.stillS : 0, progress: fresh ? r.progress : 0, ready: fresh && r.ready, fresh };
  }

  readyHint() {
    return this.phase === PHASES.SETUP && this.step === STEPS.READY && !this.readiness().ready
      && this.clock.now() - this._readyEnteredAt > READY_HINT_MS;
  }

  /** Feed the ready check ({ready, still, stillS, progress}); starts the set when Start was pressed early. */
  setReadiness(r) {
    this._readiness = { ready: Boolean(r.ready), still: Boolean(r.still), stillS: r.stillS ?? 0, progress: r.progress ?? 0, at: this.clock.now() };
    if (this.arming && r.ready && this.phase === PHASES.SETUP) void this._beginSet();
    else if (this.phase === PHASES.SETUP && this.step === STEPS.READY) this._emit();
  }

  // ---- settings ------------------------------------------------------------
  updateSettings(raw) { this.settings = sanitizeSettings({ ...this.settings, ...raw }); this._emit(); return this.settings; }
  _restSeconds() { return this.settings.restByExercise?.[this.exercise?.id] ?? this.settings.restS; }

  // ---- history lookups (for the picker and weight prefill) --------------------
  async lastByExercise() {
    const out = {};
    for (const s of await this.storage.getSets()) if (!out[s.exerciseId]) out[s.exerciseId] = s; // sorted newest first
    return out;
  }

  // ---- exercise / set-up -----------------------------------------------------
  async selectExercise(exercise = QUICK_EXERCISE) {
    if (![PHASES.HOME].includes(this.phase)) return false;
    this.error = "";
    if (!this.workout) {
      this.workout = { id: this.uuid(), startedAt: new Date(this.clock.now()).toISOString(), endedAt: null, blocks: [] };
    }
    this.exercise = exercise;
    this.block = { id: this.uuid(), exerciseId: exercise.id, exerciseName: exercise.name, startedAt: new Date(this.clock.now()).toISOString(), endedAt: null, setIds: [] };
    this.workout.blocks.push(this.block);
    this.sets = [];
    this.setNumber = 1;
    this.note = "";
    const last = (await this.lastByExercise())[exercise.id];
    this.weightKg = last ? (last.weightKg ?? null) : null;
    this.lastSet = last || null;
    this.phase = PHASES.SETUP;
    this.step = STEPS.WEIGHT;
    await this._persist();
    this._emit();
    return true;
  }

  /** Weight in kg, or null/"" for unknown. Allowed while setting up and on the review screen. */
  setWeight(kg) {
    if (kg === null || kg === undefined || kg === "") {
      this.weightKg = null;
      this._emit();
      return true;
    }
    const n = Number(kg);
    if (!Number.isFinite(n)) return false;
    this.weightKg = Math.min(MAX_WEIGHT_KG, Math.max(0, Math.round(n * 100) / 100));
    this._emit();
    return true;
  }
  stepWeight(direction) {
    if (this.weightKg === null && direction < 0) return false;
    return this.setWeight((this.weightKg ?? 0) + Math.sign(direction) * this.settings.stepKg);
  }
  setNote(text) { this.note = String(text ?? "").slice(0, 200); }

  /** A machine typed by the user: reuse a known one with the same name, otherwise save it for next time. */
  async selectCustom(name, note = "", known = []) {
    const clean = String(name ?? "").trim();
    if (!clean) { this.error = "Give the machine a name."; this._emit(); return false; }
    const same = [...known].find((e) => e.name.toLowerCase() === clean.toLowerCase());
    let exercise = same;
    if (!exercise) {
      exercise = customExercise(clean, note, this.uuid);
      try { await this.storage.saveExercise(exercise); } catch (e) { this.log(`[workout] custom exercise not saved: ${e.message}`); }
    }
    return this.selectExercise(exercise);
  }

  /** Remove a custom machine from the list (and its photo). Sets already saved keep their name. */
  async deleteCustomExercise(id) {
    if (!String(id).startsWith("custom-")) return false;
    await this.storage.deleteExercise(id);
    this._emit();
    return true;
  }

  /** Rename the exercise of the current block (also the sets already saved in it). */
  async renameExercise(name) {
    const clean = String(name ?? "").trim().slice(0, 60);
    if (!clean || !this.block || ![PHASES.SETUP, PHASES.REST, PHASES.SUMMARY].includes(this.phase)) return false;
    this.exercise = { ...this.exercise, name: clean };
    this.block = { ...this.block, exerciseName: clean };
    this.workout = { ...this.workout, blocks: this.workout.blocks.map((b) => (b.id === this.block.id ? this.block : b)) };
    this.sets = this.sets.map((s) => ({ ...s, exerciseName: clean }));
    if (this.lastSet) this.lastSet = { ...this.lastSet, exerciseName: clean };
    for (const s of this.sets) await this.storage.updateSet(s);
    if (this.sets.length) await this.storage.saveWorkout(this.workout);
    await this._persist();
    this._emit();
    return true;
  }

  /** Weight -> Ready. */
  continueToReady() {
    if (this.phase !== PHASES.SETUP || this.step !== STEPS.WEIGHT) return false;
    this.step = STEPS.READY;
    this._readyEnteredAt = this.clock.now();
    this._emit();
    return true;
  }

  /**
   * Back one stage. Returns "moved" | "confirm" (an inline confirmation was raised; answer it with
   * answerConfirm) | "stay" (rest/summary: sets are saved, use the buttons) | "home" (nothing to go back to).
   */
  async back() {
    switch (this.phase) {
      case PHASES.SETUP:
        if (this.step === STEPS.READY) {
          this.arming = false;
          this.step = STEPS.WEIGHT;
          this._emit();
          return "moved";
        }
        await this.changeMachine();
        return "moved";
      case PHASES.SET: return this.requestConfirm(CONFIRMS.CANCEL_SET) ? "confirm" : "stay";
      case PHASES.REVIEW: return this.requestConfirm(CONFIRMS.DISCARD_SET) ? "confirm" : "stay";
      case PHASES.HOME: return "home";
      default: return "stay";
    }
  }

  requestConfirm(kind) {
    this.confirm = kind;
    this._emit();
    return true;
  }

  async answerConfirm(yes) {
    const kind = this.confirm;
    this.confirm = null;
    if (yes && kind === CONFIRMS.CANCEL_SET) await this.cancelSet();
    else if (yes && kind === CONFIRMS.DISCARD_SET) await this.discardSet();
    else this._emit();
    return Boolean(yes && kind);
  }

  /**
   * Pick another machine from the weight/ready/rest/summary stages. Sets already saved stay (the block is
   * closed); an empty block is dropped. The workout continues.
   */
  async changeMachine() {
    if (![PHASES.SETUP, PHASES.REST, PHASES.SUMMARY].includes(this.phase)) return false;
    this.arming = false;
    await this._finishRest();
    if (this.sets.length === 0) this._dropBlock();
    else if (!this.block.endedAt) await this._closeBlock();
    this.exercise = null;
    this.block = null;
    this.sets = [];
    this.lastSet = null;
    this.phase = PHASES.HOME;
    this.step = STEPS.WEIGHT;
    await this._persist();
    this._emit();
    return true;
  }

  _dropBlock() {
    if (this.workout && this.block) this.workout.blocks = this.workout.blocks.filter((b) => b.id !== this.block.id);
  }

  // ---- the set ----------------------------------------------------------------
  /**
   * Start button on the Ready stage. If the machine is not still yet the set is armed ("Hold still...")
   * and starts by itself as soon as setReadiness reports ready. Returns true | "arming" | false.
   */
  async startSet() {
    if (this.phase !== PHASES.SETUP || this.step !== STEPS.READY) return false;
    if (this.arming) { this.arming = false; this._emit(); return false; } // second press cancels
    this.error = "";
    if (this.calibrate || this.readiness().ready) return this._beginSet();
    this.arming = true;
    this._emit();
    return "arming";
  }

  async _beginSet() {
    this.arming = false;
    this.error = "";
    this._counter = this.createCounter();
    this._fed = 0;
    this._seenActive = false;
    this.live = { count: 0, ready: false };
    await this._finishRest();
    this.phase = PHASES.SET;
    this._emit();
    const opts = { exercise: this.exercise.name, sensorName: this.sensorName() };
    const ok = this.calibrate ? await this.session.startSet(opts) : await this.session.startWithoutCalibration(opts);
    if (!ok && this.phase === PHASES.SET && !this._seenActive) {
      this.phase = PHASES.SETUP;
      this.step = STEPS.READY;
      this.error = this.session.snapshot().error || "The sensor is not connected. Connect it and try again.";
      this._emit();
    }
    return ok;
  }

  stopSet() { return this.session.stop(); }

  /** Discard the recording (confirmed by the caller) and go back to the Ready stage. */
  async cancelSet() {
    if (this.phase !== PHASES.SET) return false;
    this.session.abort();
    this._taking = false;
    this.confirm = null;
    this.phase = PHASES.SETUP;
    this.step = STEPS.READY;
    this._readyEnteredAt = this.clock.now();
    this._emit();
    return true;
  }

  _onSession(snap) {
    if (this.phase !== PHASES.SET) return;
    if ([STATES.CALIBRATING, STATES.RECORDING, STATES.PAUSED].includes(snap.state)) this._seenActive = true;
    const samples = snap.session?.samples;
    if (samples && this._counter) {
      for (; this._fed < samples.length; this._fed++) {
        const s = samples[this._fed];
        this._counter.push({ t: s.elapsed_s, ax: s.ax_m_s2, ay: s.ay_m_s2, az: s.az_m_s2 });
      }
      this.live = { count: this._counter.count, ready: this._counter.ready };
    }
    if (snap.state === STATES.REVIEWING && !this._taking) {
      this._taking = true;
      void Promise.resolve().then(() => this._takeReview());
      return;
    }
    if ((snap.state === STATES.IDLE || snap.state === STATES.DISCONNECTED) && this._seenActive && !snap.session && !this._taking) {
      // calibration cancelled / failed / connection lost before the set started
      this.phase = PHASES.SETUP;
      this.step = STEPS.READY;
      this.message = snap.message || "";
      this.error = snap.error || "";
      this._emit();
    }
  }

  _takeReview() {
    this._taking = false;
    const captured = this.session.releaseReview();
    if (!captured) return;
    this._openReview({
      meta: {
        startedAt: captured.startedAt || captured.createdAt,
        durationS: round((captured.durationMs || 0) / 1000, 1) ?? 0,
        sampleCount: captured.samples.length,
        droppedPackets: captured.droppedPackets || 0,
        sensorName: captured.sensorName || "",
      },
      samples: captured.samples,
    });
    this.message = "";
    this._persist().catch((e) => this.log(`[workout] persist failed: ${e.message}`));
  }

  _openReview({ meta, samples, includeSetup = false, count = null, edited = false }) {
    const withSetup = this.analyze(samples, { includeSetupPull: true });
    const without = this.analyze(samples, { includeSetupPull: false });
    const flagged = Boolean(withSetup.setupPull);
    this.review = {
      meta, samples, withSetup, without, flagged,
      repsWithSetup: withSetup.totalPulses,
      repsExcludingSetup: flagged ? withSetup.totalPulses - 1 : withSetup.totalPulses,
      includeSetup: flagged && includeSetup,
      count: null, edited, saving: false,
    };
    this._recount(count);
    this.phase = PHASES.REVIEW;
    this._emit();
  }

  _recount(forced = null) {
    const r = this.review;
    r.analysis = r.includeSetup ? r.withSetup : r.without;
    r.detected = r.includeSetup ? r.repsWithSetup : r.repsExcludingSetup;
    r.count = forced !== null ? forced : r.detected;
    r.edited = r.count !== r.detected;
  }

  setIncludeSetup(include) {
    const r = this.review;
    if (this.phase !== PHASES.REVIEW || !r || !r.flagged) return false;
    r.includeSetup = Boolean(include);
    this._recount();
    this._emit();
    return true;
  }

  editCount(n) {
    const r = this.review;
    if (this.phase !== PHASES.REVIEW || !r) return false;
    const v = Number(n);
    if (!Number.isInteger(v) || v < 0 || v > MAX_REPS) return false;
    this._recount(v);
    this._emit();
    return true;
  }
  stepCount(delta) { return this.review ? this.editCount(this.review.count + Math.sign(delta)) : false; }

  async discardSet() {
    if (this.phase !== PHASES.REVIEW) return false;
    this.review = null;
    this.confirm = null;
    this.phase = PHASES.SETUP;
    this.step = STEPS.READY;
    this._readyEnteredAt = this.clock.now();
    await this._persist();
    this._emit();
    return true;
  }

  /** "Yes, N reps": save the set (with its samples) and start the rest timer. */
  async confirmSet() {
    const r = this.review;
    if (this.phase !== PHASES.REVIEW || !r || r.saving) return false;
    r.saving = true;
    this.error = "";
    this._emit();
    const set = {
      id: this.uuid(), workoutId: this.workout.id, blockId: this.block.id,
      exerciseId: this.exercise.id, exerciseName: this.exercise.name, setNumber: this.setNumber,
      weightKg: this.weightKg, startedAt: r.meta.startedAt, durationS: r.meta.durationS,
      repsDetectedWithSetup: r.repsWithSetup, repsDetectedExcludingSetup: r.repsExcludingSetup,
      setupPullFlagged: r.flagged, setupPullIncluded: r.includeSetup,
      repsConfirmed: r.count, repsSource: r.edited ? "user-edited" : "sensor-confirmed",
      metrics: metricsRecord(r.analysis.metrics),
      pulses: r.withSetup.reps.map(pulseRecord),
      restS: null, sampleCount: r.meta.sampleCount, droppedPackets: r.meta.droppedPackets,
      sensorName: r.meta.sensorName, firmwareVersion: (typeof this.versions.firmware === "function" ? this.versions.firmware() : this.versions.firmware) ?? "",
      appVersion: this.versions.app ?? "", note: this.note,
    };
    const block = { ...this.block, setIds: [...this.block.setIds, set.id] };
    const workout = { ...this.workout, blocks: this.workout.blocks.map((b) => (b.id === block.id ? block : b)) };
    try {
      await this.storage.saveSet(set, r.samples);
      await this.storage.saveWorkout(workout);
    } catch (error) {
      r.saving = false;
      this.error = `The set was not saved (${error.message}). Your data is still here; try again.`;
      this._emit();
      return false;
    }
    this.block = block;
    this.workout = workout;
    this.sets = [...this.sets, set];
    this.lastSet = set;
    this.review = null;
    const now = this.clock.now();
    const totalS = this._restSeconds();
    this.rest = { startedAt: now, endsAt: now + totalS * 1000, totalS, done: totalS === 0 };
    this.phase = PHASES.REST;
    await this._persist();
    this._emit();
    return true;
  }

  // ---- rest timer (timestamp based: survives backgrounding and reloads) -------------
  adjustRest(deltaS) {
    if (this.phase !== PHASES.REST || !this.rest) return false;
    const rest = this.rest;
    rest.endsAt += deltaS * 1000;
    rest.totalS = Math.max(MIN_REST_S, rest.totalS + deltaS);
    rest.done = rest.endsAt <= this.clock.now() ? rest.done : false;
    this._persist().catch(() => {});
    this._emit();
    return true;
  }
  extendRest() { return this.adjustRest(REST_ADJUST_S); }
  shortenRest() { return this.adjustRest(-REST_ADJUST_S); }

  skipRest() {
    if (this.phase !== PHASES.REST || !this.rest) return false;
    this.rest.done = true;
    this.rest.skipped = true;
    this._persist().catch(() => {});
    this._emit();
    return true;
  }

  /** Call periodically (and on visibilitychange). Fires onRestDone once when the time is up. */
  tick() {
    if (this.phase !== PHASES.REST || !this.rest) return false;
    let fired = false;
    if (!this.rest.done && this.clock.now() >= this.rest.endsAt) {
      this.rest.done = true;
      fired = true;
      this.onRestDone(this.snapshot());
      this._persist().catch(() => {});
    }
    this._emit();
    return fired;
  }

  async _finishRest() {
    if (!this.rest || !this.lastSet) { this.rest = null; return; }
    const restS = Math.max(0, Math.round((this.clock.now() - this.rest.startedAt) / 1000));
    this.rest = null;
    this.lastSet = { ...this.lastSet, restS };
    this.sets = this.sets.map((s) => (s.id === this.lastSet.id ? this.lastSet : s));
    try { await this.storage.updateSet(this.lastSet); } catch (e) { this.log(`[workout] restS not saved: ${e.message}`); }
  }

  async nextSet() {
    if (this.phase !== PHASES.REST) return false;
    await this._finishRest();
    this.setNumber = this.sets.length + 1;
    this.phase = PHASES.SETUP;
    this.step = STEPS.WEIGHT;
    await this._persist();
    this._emit();
    return true;
  }

  // ---- finishing -----------------------------------------------------------------
  async _closeBlock() {
    if (!this.block) return;
    const block = { ...this.block, endedAt: new Date(this.clock.now()).toISOString() };
    this.block = block;
    this.workout = { ...this.workout, blocks: this.workout.blocks.map((b) => (b.id === block.id ? block : b)) };
    if (this.sets.length) await this.storage.saveWorkout(this.workout);
  }

  async finishExercise() {
    if (this.phase !== PHASES.REST && this.phase !== PHASES.SETUP) return false;
    await this._finishRest();
    if (this.sets.length === 0) return this.changeMachine();
    await this._closeBlock();
    this.phase = PHASES.SUMMARY;
    await this._persist();
    this._emit();
    return true;
  }

  async addExercise() {
    if (this.phase !== PHASES.SUMMARY) return false;
    this.exercise = null;
    this.block = null;
    this.sets = [];
    this.lastSet = null;
    this.phase = PHASES.HOME;
    await this._persist();
    this._emit();
    return true;
  }

  async finishWorkout() {
    if (this.phase !== PHASES.SUMMARY && this.phase !== PHASES.HOME) return false;
    if (this.workout) {
      this.workout = { ...this.workout, endedAt: new Date(this.clock.now()).toISOString() };
      if (this.workout.blocks.some((b) => b.setIds.length)) await this.storage.saveWorkout(this.workout);
    }
    const finished = this.workout;
    await this.storage.clearActive();
    Object.assign(this, { workout: null, block: null, exercise: null, sets: [], lastSet: null, rest: null, review: null, phase: PHASES.HOME });
    this._emit();
    return finished;
  }

  exerciseReportData() {
    return this.block ? buildExerciseReportData(this.block, this.sets) : null;
  }

  // ---- recovery -----------------------------------------------------------------
  async _persist() {
    if (!this.workout || (!this.review && !this.workout.blocks.some((b) => b.setIds.length))) {
      await this.storage.clearActive();
      return;
    }
    const r = this.review;
    await this.storage.setActive({
      version: 1, savedAt: new Date(this.clock.now()).toISOString(),
      // SET is not resumable (samples live in the capture); it falls back to SETUP of the same set
      phase: this.phase === PHASES.SET ? PHASES.SETUP : this.phase, step: this.phase === PHASES.SET ? STEPS.READY : this.step,
      workout: this.workout, blockId: this.block?.id ?? null, exercise: this.exercise,
      weightKg: this.weightKg, note: this.note, setNumber: this.setNumber,
      rest: this.rest, lastSetId: this.lastSet?.id ?? null,
      review: r ? { meta: r.meta, samples: r.samples, includeSetup: r.includeSetup, count: r.count, edited: r.edited } : null,
    });
  }

  /** Short description of an interrupted workout, or null. */
  async pendingWorkout() {
    const a = await this.storage.getActive();
    if (!a?.workout) return null;
    return {
      startedAt: a.workout.startedAt, exerciseName: a.exercise?.name ?? "", setNumber: a.setNumber,
      phase: a.phase, savedAt: a.savedAt,
      completedSets: a.workout.blocks.reduce((n, b) => n + b.setIds.length, 0),
    };
  }

  async discardPending() { await this.storage.clearActive(); this._emit(); }

  async resume() {
    const a = await this.storage.getActive();
    if (!a?.workout) return false;
    this.workout = a.workout;
    this.block = a.blockId ? a.workout.blocks.find((b) => b.id === a.blockId) || null : null;
    this.exercise = a.exercise;
    this.weightKg = a.weightKg ?? null;
    this.note = a.note ?? "";
    this.setNumber = a.setNumber ?? 1;
    const all = await this.storage.getSets();
    this.sets = this.block ? all.filter((s) => s.blockId === this.block.id).sort((x, y) => x.setNumber - y.setNumber) : [];
    this.lastSet = this.sets.find((s) => s.id === a.lastSetId) || this.sets[this.sets.length - 1] || null;
    this.rest = a.rest || null;
    this.review = null;
    this.phase = a.phase;
    this.step = STEPS.WEIGHT; // never resume mid ready check
    if (a.review) {
      this._openReview({ ...a.review, count: a.review.count });
    }
    if (this.phase === PHASES.REST && !this.rest) this.phase = PHASES.SETUP;
    if (this.phase === PHASES.REVIEW && !this.review) this.phase = PHASES.SETUP;
    if (!this.block && [PHASES.SETUP, PHASES.REST, PHASES.SUMMARY, PHASES.REVIEW].includes(this.phase)) this.phase = PHASES.HOME;
    this._emit();
    return true;
  }
}
