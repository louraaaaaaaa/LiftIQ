import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { SessionMachine, STATES, START_COMMAND } from "../session.js";
import { PHASES, WorkoutMachine, CONFIRMS } from "../workout.js";
import { MemoryWorkoutStorage } from "../workout-storage.js";
import { SEED_EXERCISES, customExercise, resolveImage, applyImageCredits, creditLine, creditsEntries, searchExercises } from "../exercises.js";
import { createStillnessDetector } from "../ready-check.js";
import { analyzeSet } from "../analysis/pulses.js";
import { fitSize, processPhoto, PhotoService, MAX_PHOTO_PX } from "../photos.js";
import { isDevToolsEnabled, setDevToolsEnabled, DEV_TOOLS_KEY } from "../dev-tools.js";

const fixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../tests/fixtures/seated-row-2026-11-22");
const golden = JSON.parse(fs.readFileSync(path.join(fixtures, "golden.json"), "utf8"));
function load(file) {
  const lines = fs.readFileSync(path.join(fixtures, file), "utf8").trim().split(/\r?\n/).slice(1);
  return lines.map((l) => { const c = l.split(","); return { t: +c[0], ax: +c[1], ay: +c[2], az: +c[3] }; });
}
const SET1 = load(golden.sets[0].file).map((s) => ({ elapsed_s: s.t, ax_m_s2: s.ax, ay_m_s2: s.ay, az_m_s2: s.az }));

class FakeClock { constructor() { this.time = Date.UTC(2026, 10, 22, 14, 0, 0); } now() { return this.time; } advance(ms) { this.time += ms; } }
const flush = () => new Promise((r) => setTimeout(r, 0));
const READY = { ready: true, still: true, stillS: 2, progress: 1 };

class FakeSession {
  constructor() { this.state = STATES.IDLE; this.session = null; this.listeners = new Set(); this.aborts = 0; }
  subscribe(l) { this.listeners.add(l); }
  snapshot() { return { state: this.state, session: this.session, message: "", error: "", connected: true }; }
  emit() { for (const l of [...this.listeners]) l(this.snapshot()); }
  async startWithoutCalibration() { this.session = { samples: [], startedAt: "2026-11-22T14:00:06.000Z", createdAt: "x", droppedPackets: 0 }; this.state = STATES.RECORDING; this.emit(); return true; }
  async startSet() { return false; }
  feed(s) { this.session.samples.push(...s); this.emit(); }
  async stop() { this.session.durationMs = 30000; this.state = STATES.REVIEWING; this.emit(); return true; }
  abort() { this.aborts++; this.session = null; this.state = STATES.IDLE; this.emit(); return true; }
  releaseReview() { const s = this.session; this.session = null; this.state = STATES.IDLE; this.emit(); return s; }
}

function make() {
  const clock = new FakeClock();
  const session = new FakeSession();
  const storage = new MemoryWorkoutStorage();
  let n = 0;
  const wm = new WorkoutMachine({ session, storage, clock, uuid: () => `id${++n}`, sensorName: () => "S" });
  return { clock, session, storage, wm };
}
async function recordSet(ctx) {
  const { wm } = ctx;
  if (wm.step === "weight") wm.continueToReady();
  wm.setReadiness(READY);
  await wm.startSet();
  ctx.session.feed(SET1);
  await wm.stopSet();
  await flush();
}

// ---- back navigation ---------------------------------------------------------------------
test("back from every stage before the set: ready -> weight -> machine; an empty block is dropped", async () => {
  const { wm } = make();
  assert.equal(await wm.back(), "home");
  await wm.selectExercise(SEED_EXERCISES[0]);
  assert.equal(wm.stage(), "weight");
  wm.continueToReady();
  assert.equal(wm.stage(), "ready");
  assert.equal(await wm.back(), "moved");
  assert.equal(wm.stage(), "weight");
  assert.equal(await wm.back(), "moved");
  assert.equal(wm.stage(), "machine");
  assert.equal(wm.workout.blocks.length, 0);
  assert.equal(wm.snapshot().canGoBack, false);
});

test("back from the weight stage of set 2 closes the block but keeps its sets", async () => {
  const ctx = make();
  const { wm, storage } = ctx;
  await wm.selectExercise(SEED_EXERCISES[0]);
  await recordSet(ctx);
  await wm.confirmSet();
  assert.equal(await wm.back(), "stay", "rest: use the buttons");
  await wm.nextSet();
  assert.equal(wm.stage(), "weight");
  await wm.back();
  assert.equal(wm.phase, PHASES.HOME);
  assert.equal((await storage.getSets()).length, 1);
  assert.equal(wm.workout.blocks.length, 1);
  assert.ok(wm.workout.blocks[0].endedAt);
});

test("change machine from rest keeps the workout and the earlier sets; new block for the next machine", async () => {
  const ctx = make();
  const { wm, storage } = ctx;
  await wm.selectExercise(SEED_EXERCISES[0]);
  await recordSet(ctx);
  await wm.confirmSet();
  assert.equal(wm.stage(), "rest");
  assert.equal(await wm.changeMachine(), true);
  assert.equal(wm.phase, PHASES.HOME);
  assert.ok(wm.workout, "the workout is still open");
  assert.equal((await storage.getSets())[0].restS !== undefined, true);
  await wm.selectExercise(SEED_EXERCISES[1]);
  assert.equal(wm.setNumber, 1);
  await recordSet(ctx);
  await wm.confirmSet();
  await wm.finishExercise();
  const done = await wm.finishWorkout();
  assert.equal(done.blocks.length, 2);
  assert.deepEqual(done.blocks.map((b) => b.exerciseName), ["Seated cable row", "Lat pulldown"]);
  assert.equal((await storage.getSets()).length, 2);
});

test("back during recording and review asks for an inline confirmation; nothing is lost on 'No'", async () => {
  const ctx = make();
  const { wm, session, storage } = ctx;
  await wm.selectExercise(SEED_EXERCISES[0]);
  wm.continueToReady();
  wm.setReadiness(READY);
  await wm.startSet();
  session.feed(SET1.slice(0, 400));
  assert.equal(await wm.back(), "confirm");
  assert.equal(wm.snapshot().confirm, CONFIRMS.CANCEL_SET);
  assert.equal(wm.phase, PHASES.SET);
  await wm.answerConfirm(false);
  assert.equal(wm.snapshot().confirm, null);
  assert.equal(wm.phase, PHASES.SET);
  assert.equal(session.session.samples.length, 400);
  await wm.back();
  await wm.answerConfirm(true);
  assert.equal(session.aborts, 1);
  assert.equal(wm.stage(), "ready", "cancelled set returns to the Ready stage");
  assert.equal((await storage.getSets()).length, 0);

  wm.setReadiness(READY);
  await wm.startSet();
  session.feed(SET1);
  await wm.stopSet();
  await flush();
  assert.equal(wm.phase, PHASES.REVIEW);
  assert.equal(await wm.back(), "confirm");
  assert.equal(wm.snapshot().confirm, CONFIRMS.DISCARD_SET);
  await wm.answerConfirm(false);
  assert.equal(wm.phase, PHASES.REVIEW);
  assert.equal(wm.snapshot().review.count, 8);
  await wm.back();
  await wm.answerConfirm(true);
  assert.equal(wm.stage(), "ready");
  assert.equal(wm.review, null);
});

// ---- ready check / arming -------------------------------------------------------------------
test("Start while not still arms the set and begins as soon as the machine is still; second press cancels", async () => {
  const { wm, session, clock } = make();
  await wm.selectExercise(SEED_EXERCISES[0]);
  wm.continueToReady();
  assert.equal(await wm.startSet(), "arming");
  assert.equal(wm.snapshot().arming, true);
  assert.equal(wm.phase, PHASES.SETUP);
  assert.equal(await wm.startSet(), false);
  assert.equal(wm.snapshot().arming, false);
  await wm.startSet();
  wm.setReadiness({ ready: false, still: true, stillS: 0.8, progress: 0.5 });
  assert.equal(wm.phase, PHASES.SETUP);
  wm.setReadiness(READY);
  await flush();
  assert.equal(wm.phase, PHASES.SET);
  assert.equal(session.state, STATES.RECORDING);
  void clock;
});

test("back from Ready cancels arming; stale readiness does not count; hint after 5 s without stillness", async () => {
  const { wm, clock } = make();
  await wm.selectExercise(SEED_EXERCISES[0]);
  wm.continueToReady();
  assert.equal(wm.snapshot().readyHint, false);
  clock.advance(5100);
  wm.setReadiness({ ready: false, still: false, stillS: 0, progress: 0 });
  assert.equal(wm.snapshot().readyHint, true);
  wm.setReadiness(READY);
  assert.equal(wm.snapshot().readiness.ready, true);
  assert.equal(wm.snapshot().readyHint, false);
  clock.advance(2000);
  assert.equal(wm.snapshot().readiness.ready, false, "no packets for 2 s: not ready");
  await wm.startSet();
  assert.equal(wm.snapshot().arming, true);
  await wm.back();
  assert.equal(wm.snapshot().arming, false);
  assert.equal(wm.stage(), "weight");
});

test("stillness detector on the real recordings: ready within 2 s at the start, never during a pull peak", () => {
  for (const s of golden.sets) {
    const samples = load(s.file);
    const d = createStillnessDetector();
    let firstReady = null;
    const readyAt = new Map();
    for (const p of samples) {
      const st = d.push(p);
      if (st.ready && firstReady === null) firstReady = p.t;
      readyAt.set(p.t, st.ready);
    }
    assert.ok(firstReady !== null && firstReady <= 2.0, `${s.label} ready at ${firstReady}`);
    const a = analyzeSet(samples.map((x) => ({ t: x.t, ax: x.ax, ay: x.ay, az: x.az })), { includeSetupPull: true });
    for (const pulse of a.reps) {
      const near = samples.find((x) => Math.abs(x.t - pulse.t) < 0.011);
      assert.equal(readyAt.get(near.t), false, `${s.label}: ready during the pull at ${pulse.t}`);
    }
  }
});

test("stillness detector: handling noise before the set never arms; a gap resets", () => {
  let seed = 5;
  const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296 - 0.5; };
  const d = createStillnessDetector();
  let t = 0;
  for (; t < 4; t += 0.02) assert.equal(d.push({ t, ax: rnd() * 10, ay: rnd() * 10, az: 9.8 + rnd() * 10 }).ready, false, "shaking");
  let ready = null;
  for (; t < 8; t += 0.02) { if (d.push({ t, ax: rnd() * 0.1, ay: rnd() * 0.1, az: 9.8 + rnd() * 0.1 }).ready && ready === null) ready = t; }
  assert.ok(ready >= 4 + 1.4 && ready < 4 + 2.2, `ready ${ready}`);
  assert.equal(d.push({ t: t + 3, ax: 0, ay: 0, az: 9.8 }).ready, false, "a 3 s gap restarts the check");
  const free = createStillnessDetector();
  for (let i = 0; i < 300; i++) assert.equal(free.push({ t: i * 0.02, ax: 0.1, ay: 0.1, az: 0.2 }).ready, false, "not gravity (free fall / wrong data)");
  assert.equal(free.push({ t: NaN, ax: 0, ay: 0, az: 0 }).ready, false);
});

// ---- start without calibration (SessionMachine) ----------------------------------------------------
function realSession() {
  const clock = { t: Date.UTC(2026, 10, 22, 14, 0, 0), now() { return this.t; }, setTimeout() { return 1; }, clearTimeout() {} };
  const ble = { writes: [], async write(b) { this.writes.push([...b]); }, async readValue() { throw new Error("none"); } };
  const session = new SessionMachine({ ble, storage: { save: async () => {} }, clock, uuid: () => "s1" });
  return { clock, ble, session };
}

test("SessionMachine.startWithoutCalibration records immediately, sends no firmware command, abort discards", async () => {
  const { ble, session } = realSession();
  assert.equal(session.startWithoutCalibration({ exercise: "Row" }), false, "needs a connection");
  session.bleConnected();
  assert.equal(session.startWithoutCalibration({ exercise: "Row", sensorName: "S" }), true);
  assert.equal(session.state, STATES.RECORDING);
  assert.deepEqual(ble.writes, []);
  session.onReading({ calibrationCode: 0, ax: 0, ay: 0, az: 9.8, totalAccel: 9.8, dynamicAccel: 0, phase: 0, repCount: 0 }, { seq: 10 });
  session.onReading({ calibrationCode: 0, ax: 0, ay: 0, az: 9.8, totalAccel: 9.8, dynamicAccel: 0, phase: 0, repCount: 0 }, { seq: 11 });
  assert.equal(session.session.samples.length, 2);
  assert.equal(session.session.samples[1].elapsed_s, 0.02);
  assert.equal(session.abort(), true);
  assert.equal(session.state, STATES.IDLE);
  assert.equal(session.session, null);
  assert.equal(session.abort(), false);
  // the legacy path is unchanged
  await session.startSet({ exercise: "Row" });
  assert.equal(session.state, STATES.CALIBRATING);
  assert.deepEqual(ble.writes, [Array.from(START_COMMAND)]);
  assert.equal(session.abort(), true);
  assert.equal(session.state, STATES.IDLE);
});

test("disconnect while recording (no calibration) still reaches review with the data", () => {
  const { session } = realSession();
  session.bleConnected();
  session.startWithoutCalibration({ exercise: "Row" });
  session.onReading({ calibrationCode: 0, ax: 0, ay: 0, az: 9.8, totalAccel: 9.8, dynamicAccel: 0, phase: 0, repCount: 0 }, { seq: 1 });
  session.bleDisconnected();
  assert.equal(session.state, STATES.REVIEWING);
  assert.equal(session.session.samples.length, 1);
});

// ---- photos -----------------------------------------------------------------------------------------
test("photo size fitting: longest side <= 800, never upscaled, aspect kept", () => {
  assert.deepEqual(fitSize(4000, 3000), { width: 800, height: 600 });
  assert.deepEqual(fitSize(3000, 4000), { width: 600, height: 800 });
  assert.deepEqual(fitSize(640, 480), { width: 640, height: 480 });
  assert.deepEqual(fitSize(800, 800), { width: 800, height: 800 });
  assert.equal(MAX_PHOTO_PX, 800);
  assert.throws(() => fitSize(0, 0));
});

test("processPhoto downsizes to JPEG with the fakes and rejects non-images", async () => {
  const calls = [];
  const deps = {
    async load() { return { width: 4032, height: 3024 }; },
    async render(img, w, h, mime, q) { calls.push([w, h, mime, q]); return { size: 10, type: mime }; },
  };
  const out = await processPhoto({ type: "image/heic" }, deps);
  assert.deepEqual(calls[0], [800, 600, "image/jpeg", 0.8]);
  assert.equal(out.mime, "image/jpeg");
  assert.deepEqual([out.width, out.height], [800, 600]);
  await assert.rejects(processPhoto({ type: "text/plain" }, deps), /image/);
  await assert.rejects(processPhoto(null, deps));
  await assert.rejects(processPhoto({ type: "image/png" }, { load: async () => ({ width: 10, height: 10 }), render: async () => null }), /processed/);
});

test("PhotoService stores, replaces, removes and reloads photos through the storage interface", async () => {
  const storage = new MemoryWorkoutStorage();
  const revoked = [];
  let n = 0;
  const urls = { create: () => `blob:${++n}`, revoke: (u) => revoked.push(u) };
  const process = async (file) => ({ blob: { tag: file.name }, mime: "image/jpeg", width: 800, height: 600 });
  const svc = new PhotoService({ storage, process, urls });
  assert.equal(svc.urlFor("a"), null);
  assert.equal(await svc.set("a", { name: "one" }), "blob:1");
  assert.equal((await storage.getPhoto("a")).blob.tag, "one");
  assert.equal(await svc.set("a", { name: "two" }), "blob:2", "replace");
  assert.deepEqual(revoked, ["blob:1"]);
  await svc.set("b", { name: "bee" });
  const fresh = new PhotoService({ storage, process, urls });
  await fresh.init();
  assert.ok(fresh.urlFor("a") && fresh.urlFor("b"));
  await svc.remove("a");
  assert.equal(svc.urlFor("a"), null);
  assert.equal(await storage.getPhoto("a"), undefined);
  assert.equal((await storage.getPhotos()).length, 1);
  await assert.rejects(new PhotoService({ storage, process: async () => { throw new Error("bad image"); }, urls }).set("c", {}), /bad image/);
});

test("deleting an exercise deletes its photo; custom machine removal through the workout machine", async () => {
  const ctx = make();
  const ex = customExercise("Hammer row", "", () => "h");
  await ctx.storage.saveExercise(ex);
  await ctx.storage.savePhoto({ exerciseId: ex.id, blob: { x: 1 }, mime: "image/jpeg", width: 1, height: 1 });
  assert.equal(await ctx.wm.deleteCustomExercise("seated-cable-row"), false, "seed machines cannot be removed");
  assert.equal(await ctx.wm.deleteCustomExercise(ex.id), true);
  assert.equal((await ctx.storage.getExercises()).length, 0);
  assert.equal((await ctx.storage.getPhotos()).length, 0);
});

test("image resolution: own photo first, then packaged image with credit, else pictogram", () => {
  const ex = { id: "x", image: { url: "pack/x.jpg", credit: "A. Author", license: "CC BY 4.0", sourceUrl: "https://example/x", label: "Example photo" } };
  assert.equal(resolveImage(ex, "blob:1").url, "blob:1");
  assert.equal(resolveImage(ex, "blob:1").kind, "photo");
  assert.equal(resolveImage(ex, "blob:1").credit, "", "own photos carry no credit line");
  const pack = resolveImage(ex);
  assert.deepEqual([pack.url, pack.credit, pack.license, pack.kind, pack.label], ["pack/x.jpg", "A. Author", "CC BY 4.0", "pack", "Example photo"]);
  assert.equal(resolveImage({ id: "y", image: null }), null);
  assert.equal(resolveImage(undefined), null);
  assert.ok(SEED_EXERCISES.every((e) => e.image === null), "seed list has no images until credits.json is applied");
});

// ---- default machine images (W2c) -------------------------------------------------------------------
const assetsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../assets/machines");
const credits = JSON.parse(fs.readFileSync(path.join(assetsDir, "credits.json"), "utf8"));

test("credits.json integrity: files exist, TASL fields present, no NC/ND, ids match the seed list, no orphan or duplicate files", () => {
  const ids = new Set(SEED_EXERCISES.map((e) => e.id));
  const used = new Set();
  for (const [id, c] of Object.entries(credits)) {
    assert.ok(ids.has(id), `${id} is not a seed exercise`);
    if (c.file === null) { assert.ok(c.reason, `${id}: reason for missing image`); continue; }
    used.add(c.file);
    assert.ok(fs.existsSync(path.join(assetsDir, c.file)), `${c.file} missing`);
    for (const k of ["author", "license", "licenseUrl", "sourceUrl", "title", "changes"]) assert.ok(c[k], `${id}: ${k}`);
    assert.match(c.sourceUrl, /^https:\/\/commons\.wikimedia\.org\//);
    assert.doesNotMatch(c.license, /\b(NC|ND)\b|NonCommercial|NoDerivatives/i, `${id}: ${c.license}`);
    assert.match(c.license, /^(CC0|CC BY|CC BY-SA|Public Domain)/);
  }
  const jpgs = fs.readdirSync(assetsDir).filter((f) => f.endsWith(".jpg"));
  assert.deepEqual([...jpgs].sort(), [...used].sort(), "every jpg is referenced and every reference exists (no duplicates)");
  for (const id of ["seated-cable-row", "triceps-pushdown", "cable-biceps-curl"]) {
    assert.equal(credits[id].file, "cable-station.jpg");
    assert.equal(credits[id].label, "Example photo \u2014 cable station");
  }
  for (const id of ["machine-chest-press", "machine-shoulder-press", "machine-leg-press", "leg-curl"]) assert.equal(credits[id].file, null);
  const sw = fs.readFileSync(path.resolve(assetsDir, "../../sw.js"), "utf8");
  for (const f of [...used, "credits.json"]) assert.ok(sw.includes(`./assets/machines/${f}`), `sw.js caches ${f}`);
});

test("default images are applied through the image field; own photo overrides; pictogram remains the fallback", () => {
  const list = applyImageCredits(SEED_EXERCISES, credits);
  const row = list.find((e) => e.id === "seated-cable-row");
  assert.equal(row.image.url, "./assets/machines/cable-station.jpg");
  assert.equal(row.image.generic, true);
  assert.equal(row.image.label, "Example photo \u2014 cable station");
  assert.equal(list.find((e) => e.id === "lat-pulldown").image.generic, false);
  assert.equal(list.find((e) => e.id === "leg-curl").image, null, "no photo -> pictogram");
  assert.equal(resolveImage(list.find((e) => e.id === "leg-curl")), null);
  assert.equal(resolveImage(row).kind, "pack");
  assert.equal(resolveImage(row, "blob:mine").kind, "photo");
  assert.equal(resolveImage(row, "blob:mine").url, "blob:mine");
  assert.equal(creditLine(resolveImage(list.find((e) => e.id === "lat-pulldown"))), "Photo: Teddyhtsai, CC0 1.0 \u2014 Wikimedia Commons");
  const entries = creditsEntries(credits, SEED_EXERCISES);
  assert.equal(entries.length, 4, "the generic photo is listed once");
  assert.deepEqual(entries.find((e) => e.file === "cable-station.jpg").usedFor.sort(), ["Cable biceps curl", "Cable triceps pushdown", "Seated cable row"]);
  assert.ok(entries.every((e) => e.author && e.license && e.sourceUrl && e.licenseUrl));
});

test("cable-fly is now the pec deck: stable id, new name, old name still searchable, saved sets stay linked", async () => {
  const fly = SEED_EXERCISES.find((e) => e.id === "cable-fly");
  assert.equal(fly.name, "Pec deck (machine fly)");
  assert.equal(SEED_EXERCISES.length, 10);
  assert.deepEqual(searchExercises(SEED_EXERCISES, "cable fly").map((e) => e.id), ["cable-fly"]);
  assert.deepEqual(searchExercises(SEED_EXERCISES, "pec deck").map((e) => e.id), ["cable-fly"]);
  // an older saved set (stored under the old name) is still found by id for "recent" / weight prefill
  const ctx = make();
  await ctx.storage.saveSet({ id: "old", workoutId: "w", exerciseId: "cable-fly", exerciseName: "Cable fly", setNumber: 1, weightKg: 20, repsConfirmed: 10, startedAt: "2026-11-21T10:00:00.000Z" }, []);
  await ctx.wm.selectExercise(fly);
  assert.equal(ctx.wm.weightKg, 20);
  assert.equal(ctx.wm.snapshot().lastSet.exerciseName, "Cable fly", "history keeps the name it was saved with");
});

// ---- developer tools flag -----------------------------------------------------------------------------
test("developer tools (Lab, debug) are hidden by default and the flag persists", () => {
  const store = new Map();
  const fake = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  assert.equal(isDevToolsEnabled(fake), false);
  setDevToolsEnabled(true, fake);
  assert.equal(store.get(DEV_TOOLS_KEY), "1");
  assert.equal(isDevToolsEnabled(fake), true);
  setDevToolsEnabled(false, fake);
  assert.equal(isDevToolsEnabled(fake), false);
  const broken = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } };
  assert.equal(isDevToolsEnabled(broken), false);
  assert.doesNotThrow(() => setDevToolsEnabled(true, broken));
  assert.equal(isDevToolsEnabled(null), false);
});
