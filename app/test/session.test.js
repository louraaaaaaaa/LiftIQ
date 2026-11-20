import assert from "node:assert/strict";
import test from "node:test";
import { decodeTelemetry } from "../protocol.js";
import { PacketTracker } from "../packet-stats.js";
import { SessionMachine, STATES, START_COMMAND } from "../session.js";

function makeView({ status = 0, reps = 0, phase = 0, seq = 0, battery = 3900 } = {}) {
  const view = new DataView(new ArrayBuffer(18));
  [100, 0, 981, 981, 5].forEach((value, index) => view.setInt16(index * 2, value, true));
  view.setUint16(10, seq, true);
  view.setUint8(12, phase);
  view.setUint8(13, status);
  view.setUint16(14, reps, true);
  view.setUint16(16, battery, true);
  return view;
}

function reading(options) {
  return decodeTelemetry(makeView(options));
}

class FakeClock {
  constructor() { this.time = 1_700_000_000_000; this.timers = new Map(); this.nextId = 1; }
  now() { return this.time; }
  setTimeout(fn, ms) { const id = this.nextId++; this.timers.set(id, { fn, at: this.time + ms }); return id; }
  clearTimeout(id) { this.timers.delete(id); }
  advance(ms) {
    const target = this.time + ms;
    for (;;) {
      const due = [...this.timers.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.timers.delete(due[0]);
      this.time = due[1].at;
      due[1].fn();
    }
    this.time = target;
  }
}

class FakeBle {
  constructor() { this.writes = []; this.connected = true; this.finalView = makeView({ status: 2, reps: 0 }); this.failRead = false; this.failWrite = false; }
  async write(bytes) { if (this.failWrite) throw new Error("write failed"); this.writes.push(Array.from(bytes)); }
  async readValue() { if (this.failRead) throw new Error("read failed"); return this.finalView; }
  isConnected() { return this.connected; }
}

function setup(options = {}) {
  const clock = new FakeClock();
  const ble = new FakeBle();
  const saved = [];
  const storage = { save: async (session) => { if (options.failSave) throw new Error("disk full"); saved.push(session); } };
  let counter = 0;
  const machine = new SessionMachine({ ble, storage, clock, uuid: () => `id-${++counter}` });
  machine.bleConnected();
  return { clock, ble, saved, machine };
}

// Feed packets 1 per call; helper sends status packets and advances time.
function feed(machine, options, info) {
  machine.onReading(reading(options), info);
}

async function startAndCalibrate({ machine, clock }) {
  await machine.startSet({ exercise: "Squat", sensorName: "LiftIQ-TEST" });
  feed(machine, { status: 1 });
  clock.advance(5000);
  feed(machine, { status: 2 });
}

test("connect moves disconnected -> idle and start sends the calibration command", async () => {
  const { machine, ble } = setup();
  assert.equal(machine.state, STATES.IDLE);
  assert.equal(machine.snapshot().canStart, true);
  await machine.startSet({ exercise: "Squat" });
  assert.equal(machine.state, STATES.CALIBRATING);
  assert.deepEqual(ble.writes, [Array.from(START_COMMAND)]);
  assert.equal(machine.snapshot().canStop, true);
  assert.equal(machine.snapshot().stopLabel, "Cancel");
});

test("calibrating -> recording on status 2, samples logged with seq", async () => {
  const ctx = setup();
  await startAndCalibrate(ctx);
  assert.equal(ctx.machine.state, STATES.RECORDING);
  feed(ctx.machine, { status: 2, reps: 1, phase: 1, seq: 10 }, { seq: 10, dropped: 2 });
  const { session } = ctx.machine;
  assert.equal(session.samples.length, 1);
  assert.equal(session.samples[0].seq, 10);
  assert.equal(session.droppedPackets, 2);
  assert.equal(ctx.machine.snapshot().repCount, 1);
});

test("a stale status 2 from before the start command is ignored", async () => {
  const ctx = setup();
  await ctx.machine.startSet({});
  feed(ctx.machine, { status: 2 });   // leftover, no status 1 seen, no time passed
  assert.equal(ctx.machine.state, STATES.CALIBRATING);
  feed(ctx.machine, { status: 1 });
  feed(ctx.machine, { status: 2 });
  assert.equal(ctx.machine.state, STATES.RECORDING);
});

test("lost 'status 1' packets: a later status 2 still completes once enough time passed", async () => {
  const ctx = setup();
  await ctx.machine.startSet({});
  ctx.clock.advance(5000);
  feed(ctx.machine, { status: 2 });
  assert.equal(ctx.machine.state, STATES.RECORDING);
});

test("lost 'complete' packet: later packets still carry status 2 so the set proceeds", async () => {
  const ctx = setup();
  await ctx.machine.startSet({});
  feed(ctx.machine, { status: 1 });
  ctx.clock.advance(5000);
  // the single transition packet is lost; the next ones all say status 2
  feed(ctx.machine, { status: 2, reps: 0 });
  assert.equal(ctx.machine.state, STATES.RECORDING);
  assert.equal(ctx.machine.snapshot().calibrated, true);
});

test("timeout does not strand the user: stalled, cancel works", async () => {
  const ctx = setup();
  await ctx.machine.startSet({});
  feed(ctx.machine, { status: 1 });
  ctx.clock.advance(15000);
  let snap = ctx.machine.snapshot();
  assert.equal(snap.state, STATES.CALIBRATING);
  assert.equal(snap.stalled, true);
  assert.equal(snap.canStop, true);
  assert.equal(snap.canRetry, true);
  await ctx.machine.stop();
  assert.equal(ctx.machine.state, STATES.IDLE);
  assert.equal(ctx.machine.session, null);
});

test("timeout then retry sends the start command again and re-arms the timer", async () => {
  const ctx = setup();
  await ctx.machine.startSet({});
  ctx.clock.advance(15000);
  assert.equal(ctx.machine.snapshot().stalled, true);
  await ctx.machine.retryCalibration();
  assert.equal(ctx.ble.writes.length, 2);
  assert.equal(ctx.machine.snapshot().stalled, false);
  feed(ctx.machine, { status: 1 });
  feed(ctx.machine, { status: 2 });
  assert.equal(ctx.machine.state, STATES.RECORDING);
});

test("timeout, then status 2 appears: offers to continue instead of ignoring", async () => {
  const ctx = setup();
  await ctx.machine.startSet({ exercise: "Row" });
  feed(ctx.machine, { status: 1 });
  ctx.clock.advance(15000);
  assert.equal(ctx.machine.snapshot().canContinue, false);
  feed(ctx.machine, { status: 2, reps: 0 });
  assert.equal(ctx.machine.state, STATES.CALIBRATING);
  assert.equal(ctx.machine.snapshot().canContinue, true);
  assert.equal(ctx.machine.continueSet(), true);
  assert.equal(ctx.machine.state, STATES.RECORDING);
  assert.ok(ctx.machine.session.startedAt);
});

test("firmware failure status returns to idle with an error", async () => {
  const ctx = setup();
  await ctx.machine.startSet({});
  feed(ctx.machine, { status: 3 });
  assert.equal(ctx.machine.state, STATES.IDLE);
  assert.match(ctx.machine.snapshot().error, /calibration/i);
});

test("start command failure returns to idle", async () => {
  const ctx = setup();
  ctx.ble.failWrite = true;
  await ctx.machine.startSet({});
  assert.equal(ctx.machine.state, STATES.IDLE);
  assert.match(ctx.machine.snapshot().error, /Start command failed/);
});

test("pause freezes logging but tracks firmware reps; resume continues; stop uses firmware count", async () => {
  const ctx = setup();
  await startAndCalibrate(ctx);
  feed(ctx.machine, { status: 2, reps: 1, seq: 1 }, { seq: 1, dropped: 0 });
  assert.equal(ctx.machine.pause(), true);
  assert.equal(ctx.machine.state, STATES.PAUSED);
  assert.equal(ctx.machine.snapshot().canStop, true);
  feed(ctx.machine, { status: 2, reps: 2, seq: 2 }, { seq: 2, dropped: 0 });
  feed(ctx.machine, { status: 2, reps: 3, seq: 3 }, { seq: 3, dropped: 0 });
  assert.equal(ctx.machine.session.samples.length, 1);
  assert.equal(ctx.machine.snapshot().repCount, 3);
  assert.equal(ctx.machine.resume(), true);
  assert.equal(ctx.machine.state, STATES.RECORDING);
  feed(ctx.machine, { status: 2, reps: 3, seq: 4 }, { seq: 4, dropped: 0 });
  assert.equal(ctx.machine.session.samples.length, 2);
  ctx.ble.finalView = makeView({ status: 2, reps: 4 });
  await ctx.machine.stop();
  assert.equal(ctx.machine.state, STATES.REVIEWING);
  assert.equal(ctx.machine.session.repCount, 4);
});

test("stop works from paused and survives a failed final read", async () => {
  const ctx = setup();
  await startAndCalibrate(ctx);
  feed(ctx.machine, { status: 2, reps: 5 });
  ctx.machine.pause();
  ctx.ble.failRead = true;
  await ctx.machine.stop();
  assert.equal(ctx.machine.state, STATES.REVIEWING);
  assert.equal(ctx.machine.session.repCount, 5);
});

test("review, correction and save write a CSV and return to idle", async () => {
  const ctx = setup();
  await startAndCalibrate(ctx);
  feed(ctx.machine, { status: 2, reps: 3, seq: 7 }, { seq: 7, dropped: 0 });
  await ctx.machine.stop();
  assert.equal(await ctx.machine.saveReview(4), true);
  assert.equal(ctx.machine.state, STATES.IDLE);
  assert.equal(ctx.saved.length, 1);
  assert.equal(ctx.saved[0].repCountSource, "user-corrected");
  assert.match(ctx.saved[0].csv, /seq/);
  assert.equal(ctx.machine.snapshot().lastSaved.reps, 4);
});

test("a failed save returns to reviewing so it can be retried", async () => {
  const ctx = setup({ failSave: true });
  await startAndCalibrate(ctx);
  await ctx.machine.stop();
  assert.equal(await ctx.machine.saveReview(0), false);
  assert.equal(ctx.machine.state, STATES.REVIEWING);
  assert.match(ctx.machine.snapshot().error, /disk full/);
});

test("disconnect mid-set goes to review with captured data", async () => {
  const ctx = setup();
  await startAndCalibrate(ctx);
  feed(ctx.machine, { status: 2, reps: 2 });
  ctx.ble.connected = false;
  ctx.machine.bleDisconnected();
  assert.equal(ctx.machine.state, STATES.REVIEWING);
  assert.equal(ctx.machine.session.repCount, 2);
  assert.equal(ctx.machine.snapshot().connected, false);
  await ctx.machine.saveReview(2);
  assert.equal(ctx.machine.state, STATES.DISCONNECTED);
});

test("disconnect during calibration returns to disconnected", async () => {
  const ctx = setup();
  await ctx.machine.startSet({});
  ctx.machine.bleDisconnected();
  assert.equal(ctx.machine.state, STATES.DISCONNECTED);
  assert.equal(ctx.machine.session, null);
  // the pending timeout must not resurrect calibration state
  ctx.clock.advance(20000);
  assert.equal(ctx.machine.snapshot().stalled, false);
});

test("calibration-only mode returns to idle with calibrated derived from the status byte", async () => {
  const ctx = setup();
  await ctx.machine.startSet({ calibrateOnly: true });
  feed(ctx.machine, { status: 1 });
  feed(ctx.machine, { status: 2 });
  assert.equal(ctx.machine.state, STATES.IDLE);
  assert.equal(ctx.machine.snapshot().calibrated, true);
  assert.equal(ctx.machine.session, null);
});

test("packet tracker unwraps the 16-bit counter, counts drops and rate", () => {
  let now = 0;
  const tracker = new PacketTracker(() => now);
  const feedSeq = (seq) => { now += 20; return tracker.record({ seq }, makeView({ seq })); };
  assert.deepEqual(feedSeq(65534), { seq: 65534, dropped: 0 });
  assert.deepEqual(feedSeq(65535), { seq: 65535, dropped: 0 });
  assert.deepEqual(feedSeq(0), { seq: 65536, dropped: 0 });
  assert.deepEqual(feedSeq(3), { seq: 65539, dropped: 2 });
  assert.deepEqual(tracker.record({ seq: null }, null), { seq: null, dropped: 0 });
  const snapshot = tracker.snapshot();
  assert.equal(snapshot.total, 5);
  assert.equal(snapshot.dropped, 2);
  assert.ok(snapshot.rateHz > 40 && snapshot.rateHz < 80);
  assert.match(snapshot.lastHex, /^[0-9a-f]{2}( [0-9a-f]{2}){17}$/);
});

test("elapsed_s comes from the unwrapped seq at 50 Hz; arrival_s keeps arrival time", async () => {
  const ctx = setup();
  await startAndCalibrate(ctx);
  ctx.clock.advance(1000);
  feed(ctx.machine, { status: 2, seq: 100 }, { seq: 100, dropped: 0 });
  ctx.clock.advance(5);  // arrival batching: both arrive almost together
  feed(ctx.machine, { status: 2, seq: 101 }, { seq: 101, dropped: 0 });
  feed(ctx.machine, { status: 2, seq: 150 }, { seq: 150, dropped: 48 });
  const [a, b, c] = ctx.machine.session.samples;
  assert.equal(a.elapsed_s, 0);
  assert.equal(b.elapsed_s, 0.02);
  assert.equal(c.elapsed_s, 1);
  assert.ok(a.arrival_s >= 1 && b.arrival_s - a.arrival_s < 0.01);
});

test("legacy packets without seq fall back to arrival time for elapsed_s", async () => {
  const ctx = setup();
  await startAndCalibrate(ctx);
  ctx.clock.advance(2000);
  feed(ctx.machine, { status: 2 }, { seq: null, dropped: 0 });
  const [a] = ctx.machine.session.samples;
  assert.equal(a.elapsed_s, a.arrival_s);
  assert.ok(a.elapsed_s >= 2);
});
