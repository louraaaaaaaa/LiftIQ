import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { SessionMachine, STATES } from "../session.js";
import { PHASES, WorkoutMachine, buildExerciseReportData, summaryRows, sanitizeSettings } from "../workout.js";
import { MemoryWorkoutStorage, storesToCreate, DB_VERSION } from "../workout-storage.js";
import { SEED_EXERCISES, QUICK_EXERCISE, customExercise, searchExercises, slugify, pictogramSvg } from "../exercises.js";
import { buildSetCsv, formatWeight, setFileName, setLabel, uniqueSetFileNames } from "../set-format.js";
import { pulseChartSvg, allPulses } from "../pulse-chart.js";

const dataDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../tests/fixtures/seated-row-2026-11-22");

function loadSamples(label) {
  const file = `liftiq-2026-11-20-${label}.csv`;
  const lines = fs.readFileSync(path.join(dataDir, file), "utf8").trim().split(/\r?\n/);
  const head = lines[0].split(",");
  return lines.slice(1).map((l) => {
    const c = l.split(",");
    const o = {};
    head.forEach((h, i) => { o[h] = Number.isNaN(Number(c[i])) ? c[i] : Number(c[i]); });
    return o;
  });
}
const SET1 = loadSamples("29c819f1"); // 8 reps excluding the setup pull, 9 including

class FakeClock {
  constructor() { this.time = Date.UTC(2026, 10, 22, 14, 0, 0); }
  now() { return this.time; }
  advance(ms) { this.time += ms; }
}

// Minimal stand-in for SessionMachine (same surface the workout machine uses).
class FakeSession {
  constructor() { this.state = STATES.IDLE; this.session = null; this.listeners = new Set(); this.starts = []; this.refuse = false; }
  subscribe(l) { this.listeners.add(l); return () => this.listeners.delete(l); }
  snapshot() { return { state: this.state, session: this.session, message: "", error: "", connected: true }; }
  emit() { for (const l of [...this.listeners]) l(this.snapshot()); }
  async startSet(opts) {
    if (this.refuse) return false;
    this.starts.push(opts);
    this.session = { samples: [], startedAt: null, createdAt: "2026-11-22T14:00:00.000Z", exercise: opts.exercise, sensorName: opts.sensorName, droppedPackets: 1 };
    this.state = STATES.CALIBRATING; this.emit();
    return true;
  }
  async startWithoutCalibration(opts) {
    if (this.refuse) return false;
    this.starts.push(opts);
    this.session = { samples: [], startedAt: "2026-11-22T14:00:06.000Z", createdAt: "2026-11-22T14:00:06.000Z", exercise: opts.exercise, sensorName: opts.sensorName, droppedPackets: 1 };
    this.state = STATES.RECORDING; this.emit();
    return true;
  }
  abort() { this.session = null; this.state = STATES.IDLE; this.emit(); return true; }
  record() { this.session.startedAt = "2026-11-22T14:00:06.000Z"; this.state = STATES.RECORDING; this.emit(); }
  feed(samples) { this.session.samples.push(...samples); this.emit(); }
  async stop() {
    if (this.state === STATES.CALIBRATING) { this.session = null; this.state = STATES.IDLE; this.emit(); return true; }
    this.session.durationMs = 40000; this.state = STATES.REVIEWING; this.emit(); return true;
  }
  disconnect() { if (this.state === STATES.RECORDING) { this.session.durationMs = 30000; this.state = STATES.REVIEWING; } else { this.session = null; this.state = STATES.DISCONNECTED; } this.emit(); }
  releaseReview() { if (this.state !== STATES.REVIEWING) return null; const s = this.session; this.session = null; this.state = STATES.IDLE; this.emit(); return s; }
}

const flush = () => new Promise((r) => setTimeout(r, 0));

const READY = { ready: true, still: true, stillS: 2, progress: 1 };

function make(options = {}) {
  const clock = new FakeClock();
  const session = new FakeSession();
  const storage = options.storage || new MemoryWorkoutStorage();
  let n = 0;
  const rests = [];
  const wm = new WorkoutMachine({
    session, storage, clock, uuid: () => `id${++n}`, settings: options.settings,
    versions: { app: "1.1.0-dev", firmware: "fw1" }, sensorName: () => "LiftIQ-1",
    onRestDone: () => rests.push(clock.now()), calibrate: Boolean(options.calibrate),
  });
  return { clock, session, storage, wm, rests };
}

async function toReady(wm) {
  if (wm.step === "weight") wm.continueToReady();
  wm.setReadiness(READY);
}

async function recordSet(ctx, samples = SET1) {
  await toReady(ctx.wm);
  await ctx.wm.startSet();
  ctx.session.feed(samples);
  await ctx.wm.stopSet();
  await flush();
}

test("full flow: pick exercise, set up, record, review (exclude setup), confirm, rest, next set, finish", async () => {
  const ctx = make();
  const { wm, session, storage, clock } = ctx;
  assert.equal(wm.phase, PHASES.HOME);
  await wm.selectExercise(SEED_EXERCISES[0]);
  assert.equal(wm.phase, PHASES.SETUP);
  assert.equal(wm.setNumber, 1);
  wm.setWeight(45);
  wm.stepWeight(1);
  assert.equal(wm.weightKg, 50);
  wm.stepWeight(-1); wm.stepWeight(-1);
  assert.equal(wm.weightKg, 40);
  wm.setWeight(45);
  wm.setNote("slow tempo");

  assert.equal(await wm.startSet(), false, "Start is only possible on the Ready stage");
  assert.equal(wm.stage(), "weight");
  wm.continueToReady();
  assert.equal(wm.stage(), "ready");
  wm.setReadiness(READY);
  await wm.startSet();
  assert.equal(wm.phase, PHASES.SET);
  assert.deepEqual(session.starts[0], { exercise: "Seated cable row", sensorName: "LiftIQ-1" });
  session.feed(SET1);
  assert.equal(wm.live.ready, true);
  assert.equal(wm.live.count, 9, "live counter counts the setup pull");
  await wm.stopSet();
  await flush();

  assert.equal(wm.phase, PHASES.REVIEW);
  let snap = wm.snapshot();
  assert.equal(snap.review.flagged, true);
  assert.equal(snap.review.includeSetup, false);
  assert.equal(snap.review.count, 8);
  assert.equal(snap.review.repsWithSetup, 9);
  assert.equal(snap.review.repsExcludingSetup, 8);
  assert.equal(snap.review.analysis.repCount, 8);

  wm.setIncludeSetup(true);
  assert.equal(wm.snapshot().review.count, 9);
  assert.equal(wm.snapshot().review.analysis.repCount, 9);
  wm.setIncludeSetup(false);
  assert.equal(wm.snapshot().review.count, 8);

  assert.equal(await wm.confirmSet(), true);
  assert.equal(wm.phase, PHASES.REST);
  const saved = (await storage.getSets())[0];
  assert.equal(saved.repsConfirmed, 8);
  assert.equal(saved.repsSource, "sensor-confirmed");
  assert.equal(saved.setupPullIncluded, false);
  assert.equal(saved.repsDetectedWithSetup, 9);
  assert.equal(saved.repsDetectedExcludingSetup, 8);
  assert.equal(saved.weightKg, 45);
  assert.equal(saved.setNumber, 1);
  assert.equal(saved.note, "slow tempo");
  assert.equal(saved.firmwareVersion, "fw1");
  assert.equal(saved.pulses.length, 9);
  assert.equal(saved.pulses[0].setup, true);
  assert.ok(saved.metrics.meanPeakVelocity > 0.5);
  assert.equal((await storage.getSamples(saved.id)).length, SET1.length);
  assert.equal((await storage.getWorkouts())[0].blocks[0].setIds[0], saved.id);

  // rest: 90 s default
  assert.equal(wm.snapshot().rest.remainingS, 90);
  clock.advance(30_000);
  assert.equal(wm.snapshot().rest.remainingS, 60);
  assert.equal(wm.tick(), false);
  wm.extendRest();
  assert.equal(wm.snapshot().rest.remainingS, 75);
  wm.shortenRest(); wm.shortenRest();
  assert.equal(wm.snapshot().rest.remainingS, 45);

  clock.advance(46_000);
  assert.equal(wm.tick(), true, "fires once at zero");
  assert.equal(ctx.rests.length, 1);
  assert.equal(wm.tick(), false);
  assert.equal(ctx.rests.length, 1);
  assert.equal(wm.snapshot().rest.remainingS, 0);

  assert.equal(await wm.nextSet(), true);
  assert.equal(wm.phase, PHASES.SETUP);
  assert.equal(wm.setNumber, 2);
  assert.equal(wm.weightKg, 45, "weight prefilled");
  assert.equal((await storage.getSets())[0].restS, 76);

  await recordSet(ctx);
  wm.setIncludeSetup(true);
  await wm.confirmSet();
  assert.equal((await storage.getSets()).length, 2);
  await wm.finishExercise();
  assert.equal(wm.phase, PHASES.SUMMARY);
  const rows = wm.snapshot().summary;
  assert.deepEqual(rows.map((r) => [r.setNumber, r.reps]), [[1, 8], [2, 9]]);

  const report = wm.exerciseReportData();
  assert.equal(report.exerciseName, "Seated cable row");
  assert.equal(report.sets.length, 2);
  assert.equal(report.sets[1].setupPullIncluded, true);
  assert.ok(report.endedAt);

  await wm.addExercise();
  assert.equal(wm.phase, PHASES.HOME);
  await wm.selectExercise(SEED_EXERCISES[1]);
  assert.equal(wm.setNumber, 1);
  await wm.changeMachine();
  assert.equal(wm.phase, PHASES.HOME);
  const done = await wm.finishWorkout();
  assert.equal(done.blocks.length, 1, "empty blocks are dropped");
  assert.ok(done.endedAt);
  assert.equal(await storage.getActive(), null);
  assert.equal(wm.workout, null);
  assert.equal((await storage.getWorkouts()).length, 1);
});

test("edit count sets source user-edited; setting back to detected is sensor-confirmed; discard returns to setup", async () => {
  const ctx = make();
  const { wm, storage } = ctx;
  await wm.selectExercise(QUICK_EXERCISE);
  await recordSet(ctx);
  assert.equal(wm.editCount(7), true);
  assert.equal(wm.snapshot().review.edited, true);
  assert.equal(wm.editCount(-1), false);
  assert.equal(wm.editCount(1.5), false);
  assert.equal(wm.editCount(1000), false);
  wm.stepCount(1);
  assert.equal(wm.snapshot().review.count, 8);
  assert.equal(wm.snapshot().review.edited, false);
  wm.stepCount(-1);
  await wm.confirmSet();
  assert.equal((await storage.getSets())[0].repsSource, "user-edited");
  assert.equal((await storage.getSets())[0].repsConfirmed, 7);
  await wm.nextSet();
  await recordSet(ctx);
  assert.equal(await wm.discardSet(), true);
  assert.equal(wm.phase, PHASES.SETUP);
  assert.equal(wm.setNumber, 2);
  assert.equal((await storage.getSets()).length, 1);
});

test("legacy calibration path (calibrate: true): cancel returns to setup; refused start keeps setup with an error", async () => {
  const ctx = make({ calibrate: true });
  await ctx.wm.selectExercise(SEED_EXERCISES[2]);
  ctx.wm.continueToReady();
  await ctx.wm.startSet();
  assert.equal(ctx.wm.phase, PHASES.SET);
  await ctx.wm.stopSet();
  assert.equal(ctx.wm.phase, PHASES.SETUP);
  ctx.session.refuse = true;
  assert.equal(await ctx.wm.startSet(), false);
  assert.equal(ctx.wm.phase, PHASES.SETUP);
  assert.ok(ctx.wm.error);
});

test("disconnect mid-set still goes to review with the captured data", async () => {
  const ctx = make();
  await ctx.wm.selectExercise(SEED_EXERCISES[0]);
  await toReady(ctx.wm);
  await ctx.wm.startSet();
  ctx.session.feed(SET1.slice(0, 1200));
  ctx.session.disconnect();
  await flush();
  assert.equal(ctx.wm.phase, PHASES.REVIEW);
  assert.ok(ctx.wm.snapshot().review.count >= 4);
  assert.equal(await ctx.wm.confirmSet(), true);
});

test("disconnect during calibration (legacy path) returns to setup", async () => {
  const ctx = make({ calibrate: true });
  await ctx.wm.selectExercise(SEED_EXERCISES[0]);
  ctx.wm.continueToReady();
  await ctx.wm.startSet();
  ctx.session.disconnect();
  assert.equal(ctx.wm.phase, PHASES.SETUP);
});

test("failed save keeps the review and the data; retry succeeds", async () => {
  const ctx = make();
  await ctx.wm.selectExercise(SEED_EXERCISES[0]);
  await recordSet(ctx);
  ctx.storage.failNextSave = true;
  assert.equal(await ctx.wm.confirmSet(), false);
  assert.equal(ctx.wm.phase, PHASES.REVIEW);
  assert.match(ctx.wm.error, /not saved/);
  assert.equal(await ctx.wm.confirmSet(), true);
  assert.equal((await ctx.storage.getSets()).length, 1);
});

test("rest timer: skip, zero-length rest, per-exercise override, background resume via timestamps", async () => {
  const ctx = make({ settings: { restS: 20, stepKg: 2.5, restByExercise: { "leg-curl": 5 } } });
  const { wm, clock } = ctx;
  await wm.selectExercise(SEED_EXERCISES[0]);
  await recordSet(ctx);
  await wm.confirmSet();
  assert.equal(wm.snapshot().rest.remainingS, 20);
  wm.skipRest();
  assert.equal(wm.rest.done, true);
  assert.equal(wm.tick(), false, "skip never alarms");
  assert.equal(ctx.rests.length, 0);
  await wm.nextSet();
  wm.stepWeight(1);
  assert.equal(wm.weightKg, 2.5);

  // background: the tab is frozen for 5 minutes; the first tick afterwards fires once
  await recordSet(ctx);
  await wm.confirmSet();
  clock.advance(300_000);
  assert.equal(wm.snapshot().rest.remainingS, 0);
  assert.equal(wm.tick(), true);
  assert.equal(ctx.rests.length, 1);
  await wm.finishExercise();
  await wm.addExercise();
  await wm.selectExercise(SEED_EXERCISES.find((e) => e.id === "leg-curl"));
  await recordSet(ctx);
  await wm.confirmSet();
  assert.equal(wm.snapshot().rest.remainingS, 5);
});

test("resume after reload: rest phase, setup phase and an unsaved review", async () => {
  const storage = new MemoryWorkoutStorage();
  const a = make({ storage });
  await a.wm.selectExercise(SEED_EXERCISES[0]);
  await recordSet(a);
  // reload while reviewing: data must survive
  const b = make({ storage });
  assert.equal((await b.wm.pendingWorkout()).phase, "review");
  assert.equal(await b.wm.resume(), true);
  assert.equal(b.wm.phase, PHASES.REVIEW);
  assert.equal(b.wm.snapshot().review.count, 8);
  await b.wm.confirmSet();
  b.clock.advance(10_000);
  // reload during rest
  const c = make({ storage });
  c.clock.time = b.clock.time;
  await c.wm.resume();
  assert.equal(c.wm.phase, PHASES.REST);
  assert.equal(c.wm.snapshot().rest.remainingS, 80);
  assert.equal(c.wm.sets.length, 1);
  assert.equal(c.wm.exercise.id, "seated-cable-row");
  await c.wm.nextSet();
  assert.equal(c.wm.setNumber, 2);
  // reload in setup (set in progress is not resumable) keeps exercise, weight and set number
  const d = make({ storage });
  await d.wm.resume();
  assert.equal(d.wm.phase, PHASES.SETUP);
  assert.equal(d.wm.setNumber, 2);
  assert.equal(d.wm.exercise.name, "Seated cable row");
  assert.equal(d.wm.sets.length, 1);
  // nothing pending after the workout is finished
  await d.wm.finishExercise();
  await d.wm.finishWorkout();
  assert.equal(await make({ storage }).wm.pendingWorkout(), null);
  assert.equal(await make({ storage }).wm.resume(), false);
});

test("a workout without saved sets leaves nothing to resume", async () => {
  const ctx = make();
  await ctx.wm.selectExercise(SEED_EXERCISES[0]);
  assert.equal(await ctx.wm.pendingWorkout(), null);
});

test("works with the real SessionMachine (releaseReview) and a synthetic 50 Hz set", async () => {
  const clock = { t: Date.UTC(2026, 10, 22, 14, 0, 0), now() { return this.t; }, setTimeout() { return 1; }, clearTimeout() {} };
  const ble = { writes: [], async write(b) { this.writes.push([...b]); }, async readValue() { throw new Error("no read"); } };
  const session = new SessionMachine({ ble, storage: { save: async () => {} }, clock, uuid: () => "s1" });
  const wm = new WorkoutMachine({ session, storage: new MemoryWorkoutStorage(), clock, uuid: (() => { let n = 0; return () => `w${++n}`; })() });
  session.bleConnected();
  await wm.selectExercise(SEED_EXERCISES[0]);
  await toReady(wm);
  await wm.startSet();
  assert.equal(session.state, STATES.RECORDING, "recording starts immediately, no firmware calibration");
  assert.deepEqual(ble.writes, [], "no firmware command is sent in the Train flow");
  const mk = (i, code) => ({ calibrationCode: code, ax: SET1[i].ax_m_s2, ay: SET1[i].ay_m_s2, az: SET1[i].az_m_s2, totalAccel: 10, dynamicAccel: 0, phase: 0, repCount: 0 });
  SET1.forEach((s, i) => { clock.t += 20; session.onReading(mk(i, 0), { seq: 100 + i }); });
  assert.equal(wm.live.count, 9);
  await wm.stopSet();
  await flush();
  assert.equal(wm.phase, PHASES.REVIEW);
  assert.equal(session.state, STATES.IDLE);
  assert.equal(wm.snapshot().review.count, 8);
  assert.equal(wm.snapshot().review.repsWithSetup, 9);
});

test("analysis integration on a real recording and the review chart", () => {
  const ctx = make();
  const a = ctx.wm.analyze(SET1, { includeSetupPull: false });
  assert.equal(a.repCount, 8);
  assert.equal(ctx.wm.analyze(SET1, { includeSetupPull: true }).repCount, 9);
  const svg = pulseChartSvg(a.series, allPulses(a));
  assert.equal(allPulses(ctx.wm.analyze(SET1, { includeSetupPull: true })).length, 9, "no duplicate setup pull");
  assert.match(svg, /^<svg/);
  assert.ok(svg.includes("pc-setup"));
  assert.equal((svg.match(/class="pc-label/g) || []).length, 9);
  assert.match(pulseChartSvg({ t: [], v: [] }, []), /^<svg/);
});

test("file names (no weight/reps), collisions, labels, slugs and weight formatting", () => {
  const at = new Date(2026, 10, 22, 14, 5).toISOString();
  const set = { id: "1", exerciseName: "Seated cable row", setNumber: 2, weightKg: 42.5, repsConfirmed: 8, startedAt: at };
  assert.equal(setLabel({ ...set, weightKg: 45 }), "Seated cable row · Set 2 · 45 kg · 8 reps · 22 Nov 2026 14:05");
  assert.equal(setLabel({ ...set, weightKg: null }), "Seated cable row · Set 2 · 8 reps · 22 Nov 2026 14:05", "unknown weight is omitted");
  assert.equal(setLabel({ ...set, repsConfirmed: 1 }).includes("1 rep ·"), true);
  assert.equal(setFileName(set), "liftiq_2026-11-22_seated-cable-row_set2.csv");
  assert.equal(setFileName({ ...set, weightKg: null, repsConfirmed: 3 }), "liftiq_2026-11-22_seated-cable-row_set2.csv");
  assert.equal(setFileName({ ...set, exerciseName: "Cable triceps pushdown / Ünï" }), "liftiq_2026-11-22_cable-triceps-pushdown-uni_set2.csv");
  assert.equal(setFileName(set, ["liftiq_2026-11-22_seated-cable-row_set2.csv"]), "liftiq_2026-11-22_seated-cable-row_set2_2.csv");
  assert.equal(setFileName(set, ["liftiq_2026-11-22_seated-cable-row_set2.csv", "liftiq_2026-11-22_seated-cable-row_set2_2.csv"]), "liftiq_2026-11-22_seated-cable-row_set2_3.csv");
  // a second workout the same day: the earlier set keeps the plain name
  const later = { ...set, id: "2", startedAt: new Date(2026, 10, 22, 18, 0).toISOString() };
  const third = { ...set, id: "3", startedAt: new Date(2026, 10, 22, 19, 0).toISOString() };
  const other = { ...set, id: "4", setNumber: 3 };
  const names = uniqueSetFileNames([third, later, set, other]);
  assert.equal(names.get("1"), "liftiq_2026-11-22_seated-cable-row_set2.csv");
  assert.equal(names.get("2"), "liftiq_2026-11-22_seated-cable-row_set2_2.csv");
  assert.equal(names.get("3"), "liftiq_2026-11-22_seated-cable-row_set2_3.csv");
  assert.equal(names.get("4"), "liftiq_2026-11-22_seated-cable-row_set3.csv");
  assert.equal(slugify("  "), "exercise");
  assert.equal(formatWeight(42.50), "42.5");
  assert.equal(formatWeight(null), "");
  assert.equal(formatWeight(""), "");
});

test("weight is optional: unknown stays null, can be set on the review screen, next set prefilled", async () => {
  const ctx = make();
  const { wm, storage } = ctx;
  await wm.selectExercise(SEED_EXERCISES[0]);
  assert.equal(wm.weightKg, null);
  assert.equal(wm.stepWeight(-1), false);
  wm.stepWeight(1);
  assert.equal(wm.weightKg, 5);
  wm.setWeight("");
  assert.equal(wm.weightKg, null);
  await recordSet(ctx);
  assert.equal(wm.snapshot().weightKg, null);
  await wm.confirmSet();
  assert.equal((await storage.getSets())[0].weightKg, null);
  assert.equal(ctx.wm.snapshot().lastSet.weightKg, null);
  await wm.nextSet();
  assert.equal(wm.weightKg, null);
  await recordSet(ctx);
  assert.equal(wm.setWeight(42.5), true, "set or corrected on the review screen");
  wm.stepWeight(-1);
  assert.equal(wm.weightKg, 37.5);
  await wm.confirmSet();
  assert.equal((await storage.getSets()).find((s) => s.setNumber === 2).weightKg, 37.5);
  await wm.nextSet();
  assert.equal(wm.weightKg, 37.5, "next set prefilled from the previous one");
  assert.equal(wm.setWeight("abc"), false);
});

test("own machine name: saved as a custom exercise, reused next time; rename the block's exercise", async () => {
  const ctx = make();
  const { wm, storage } = ctx;
  assert.equal(await wm.selectCustom("   "), false);
  assert.equal(await wm.selectCustom("Hammer Strength row"), true);
  assert.equal(wm.exercise.custom, true);
  assert.equal((await storage.getExercises()).length, 1);
  await recordSet(ctx);
  await wm.confirmSet();
  assert.equal(await wm.renameExercise("Hammer row (old)"), true);
  assert.equal((await storage.getSets())[0].exerciseName, "Hammer row (old)");
  assert.equal(wm.block.exerciseName, "Hammer row (old)");
  assert.equal((await storage.getWorkouts())[0].blocks[0].exerciseName, "Hammer row (old)");
  assert.equal(await wm.renameExercise(" "), false);
  await wm.finishExercise();
  await wm.addExercise();
  const known = await storage.getExercises();
  await wm.selectCustom("hammer strength ROW", "", known);
  assert.equal(wm.exercise.id, known[0].id, "same name reuses the saved custom exercise");
  assert.equal((await storage.getExercises()).length, 1);
});

test("per-set CSV: header lines, columns, actual_rep_count = confirmed, vertical series", () => {
  const set = { exerciseName: "Seated cable row", setNumber: 1, weightKg: 45, repsConfirmed: 8, repsSource: "sensor-confirmed", repsDetectedWithSetup: 9, repsDetectedExcludingSetup: 8, setupPullFlagged: true, setupPullIncluded: false, firmwareVersion: "fw1", appVersion: "1.1.0-dev", sensorName: "LiftIQ-1", startedAt: "2026-11-22T14:05:00.000Z", note: "a, \"b\"" };
  const samples = SET1.slice(0, 500);
  const csv = buildSetCsv(set, samples);
  const lines = csv.trim().split("\r\n");
  assert.equal(lines[0], "# format: liftiq-set v1");
  assert.ok(lines.includes("# weight_kg: 45"));
  assert.ok(lines.includes("# reps_detected_with_setup: 9"));
  assert.ok(lines.includes("# reps_confirmed: 8"));
  const header = lines.findIndex((l) => !l.startsWith("#"));
  const cols = lines[header].split(",");
  assert.equal(cols.slice(0, 12).join(","), "elapsed_s,ax_m_s2,ay_m_s2,az_m_s2,total_accel_m_s2,dynamic_accel_m_s2,phase,phase_id,rep_count,seq,actual_rep_count,arrival_s");
  assert.deepEqual(cols.slice(12), ["vert_accel_m_s2", "vert_velocity_m_s"]);
  const row = lines[header + 300].split(",");
  assert.equal(row.length, 14);
  assert.equal(row[10], "8");
  assert.ok(Number.isFinite(Number(row[13])));
  assert.equal(lines.length, header + 1 + 500);
});

test("exercise library, search and custom exercises", () => {
  assert.equal(SEED_EXERCISES.length, 10);
  for (const e of SEED_EXERCISES) {
    assert.equal(e.opengymId, null);
    assert.ok(e.name && e.cue && e.muscles.length);
    assert.match(pictogramSvg(e.pictogram), /<svg[\s\S]*<\/svg>/);
  }
  assert.equal(new Set(SEED_EXERCISES.map((e) => e.id)).size, 10);
  assert.deepEqual(searchExercises(SEED_EXERCISES, "row").map((e) => e.id), ["seated-cable-row"]);
  assert.ok(searchExercises(SEED_EXERCISES, "quads").length >= 2);
  assert.equal(searchExercises(SEED_EXERCISES, "").length, 10);
  const c = customExercise("  Face pull ", "rope", () => "x");
  assert.equal(c.id, "custom-x");
  assert.equal(c.name, "Face pull");
  assert.throws(() => customExercise("  "));
});

test("migration plan from v0/v1/v2 is additive and never recreates legacy stores", () => {
  assert.equal(DB_VERSION, 4);
  const names = (o) => storesToCreate(o, 4).map((s) => s.name);
  assert.deepEqual(names(2), ["exercises", "workouts", "sets", "setSamples", "meta", "photos"]);
  assert.deepEqual(names(3), ["photos"], "a v3 database only gains the photos store");
  assert.deepEqual(names(1), ["rawSessions", "exercises", "workouts", "sets", "setSamples", "meta", "photos"]);
  assert.deepEqual(names(0).slice(0, 2), ["sessions", "rawSessions"]);
  assert.deepEqual(names(4), []);
});

test("storage interface (memory): sets, samples, workouts, deletion and isolation of stored copies", async () => {
  const s = new MemoryWorkoutStorage();
  const set = { id: "a", workoutId: "w", startedAt: "2026-01-01", x: 1 };
  const samples = [{ t: 1 }];
  await s.saveSet(set, samples);
  set.x = 2; samples[0].t = 9;
  assert.equal((await s.getSet("a")).x, 1);
  assert.equal((await s.getSamples("a"))[0].t, 1);
  await s.saveSet({ id: "b", workoutId: "w", startedAt: "2026-02-01" }, []);
  assert.deepEqual((await s.getSets()).map((x) => x.id), ["b", "a"]);
  await s.saveWorkout({ id: "w", startedAt: "2026-01-01", blocks: [] });
  await s.deleteSet("a");
  assert.equal(await s.getSet("a"), undefined);
  await s.deleteWorkout("w");
  assert.equal((await s.getSets()).length, 0);
  await s.setActive({ k: 1 });
  assert.deepEqual(await s.getActive(), { k: 1 });
  await s.clearActive();
  assert.equal(await s.getActive(), null);
  await s.saveExercise({ id: "e", name: "E" });
  assert.equal((await s.getExercises()).length, 1);
});

test("settings are sanitised", () => {
  assert.deepEqual(sanitizeSettings({ restS: -5, stepKg: 0 }), { restS: 90, stepKg: 5, restByExercise: {} });
  assert.equal(sanitizeSettings({ restS: 120.4, stepKg: 2.5 }).restS, 120);
  assert.deepEqual(summaryRows([{ setNumber: 2, weightKg: 1, repsConfirmed: 3, metrics: {} }, { setNumber: 1, weightKg: 1, repsConfirmed: 4 }]).map((r) => r.setNumber), [1, 2]);
  assert.equal(buildExerciseReportData({ id: "b", exerciseId: "e", exerciseName: "E", startedAt: "x" }, []).sets.length, 0);
});
