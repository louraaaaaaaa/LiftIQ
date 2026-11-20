// (iii) Behavioural gate: feed the STABLE app's session state machine the packet SEQUENCES a v1
// firmware produces (docs/PROTOCOL.md "behavioural guarantees") and check it reaches the expected
// states. A firmware change that breaks these guarantees breaks the released app, so this must
// stay green for every firmware version.
import assert from "node:assert/strict";
import test from "node:test";
import { PacketTracker } from "../../app/stable/packet-stats.js";
import { decodeTelemetry } from "../../app/stable/protocol.js";
import { STATES, SessionMachine, START_COMMAND } from "../../app/stable/session.js";
import { packet } from "./helpers.js";

const PERIOD_MS = 20; // 50 Hz telemetry
const CALIBRATION_MS = 5000; // firmware calibration length

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

// Minimal v1 firmware model: persistent status byte in every packet, status 1 immediately after the
// 0x01 write, then 2 (or 3) after ~5 s, reps reset to 0 on calibration, 50 Hz cadence, READ of the
// notify characteristic returns the latest packet. Unknown opcodes are ignored.
class FirmwareModel {
  constructor({ failCalibration = false } = {}) {
    this.status = 0;
    this.reps = 0;
    this.seq = 0;
    this.battery = 4000;
    this.phase = 0;
    this.calibrationEndsAt = null;
    this.failCalibration = failCalibration;
    this.t = 0;
    this.last = packet({});
    this.writes = [];
  }

  onWrite(bytes) {
    this.writes.push(Array.from(bytes));
    if (bytes[0] === 0x01) {
      this.status = 1;
      this.reps = 0;
      this.calibrationEndsAt = this.t + CALIBRATION_MS;
    }
  }

  tick() {
    this.t += PERIOD_MS;
    if (this.calibrationEndsAt !== null && this.t >= this.calibrationEndsAt) {
      this.status = this.failCalibration ? 3 : 2;
      this.calibrationEndsAt = null;
    }
    const view = packet({ seq: this.seq++, status: this.status, reps: this.reps, phase: this.phase, battery: this.battery });
    this.last = view;
    return view;
  }
}

function setup(firmwareOptions) {
  const clock = new FakeClock();
  const firmware = new FirmwareModel(firmwareOptions);
  const ble = {
    connected: true,
    async write(bytes) { firmware.onWrite(bytes); },
    async readValue() { return firmware.last; },
    isConnected() { return this.connected; },
  };
  let n = 0;
  const machine = new SessionMachine({ ble, storage: { save: async () => {} }, clock, uuid: () => `id-${++n}` });
  const tracker = new PacketTracker();
  // One 20 ms firmware tick delivered to the app, exactly as ble.js does it.
  const step = (lost = false) => {
    const view = firmware.tick();
    clock.advance(PERIOD_MS);
    if (lost) return;
    const reading = decodeTelemetry(view);
    assert.ok(reading, "stable decoder must accept every packet the firmware emits");
    machine.onReading(reading, tracker.record(reading, view));
  };
  const run = (ms, dropEvery = 0) => {
    for (let i = 0; i < ms / PERIOD_MS; i++) step(dropEvery > 0 && i % dropEvery === dropEvery - 1);
  };
  return { clock, firmware, ble, machine, step, run };
}

test("connect + telemetry: notifications on connect move the machine to idle", () => {
  const { machine, run, firmware } = setup();
  machine.bleConnected();
  run(200);
  assert.equal(machine.state, STATES.IDLE);
  assert.equal(machine.firmwareStatus, 0);
  assert.equal(firmware.writes.length, 0);
});

test("start set: write 0x01, status-1 packets for ~5 s, then 2 -> recording with samples", async () => {
  const { machine, run, firmware } = setup();
  machine.bleConnected();
  run(100);
  assert.equal(await machine.startSet({ exercise: "Squat" }), true);
  assert.deepEqual(firmware.writes[0], Array.from(START_COMMAND));
  assert.equal(machine.state, STATES.CALIBRATING);
  run(500);
  assert.equal(machine.firmwareStatus, 1, "status 1 must be visible right after the command");
  assert.equal(machine.state, STATES.CALIBRATING);
  run(4000);
  assert.equal(machine.state, STATES.CALIBRATING, "still calibrating just before ~5 s");
  run(1000);
  assert.equal(machine.state, STATES.RECORDING);
  assert.equal(machine.stalled, false);
  firmware.reps = 3;
  run(1000);
  assert.equal(machine.snapshot().repCount, 3);
  assert.ok(machine.session.samples.length >= 49);
  assert.ok(machine.session.samples.every((s) => s.seq !== null && s.elapsed_s >= 0));
  assert.equal(machine.session.droppedPackets, 0);
});

test("start set: calibration succeeds even if the app misses every status-1 packet (status is persistent)", async () => {
  const { machine, firmware, step, run } = setup();
  machine.bleConnected();
  run(100);
  await machine.startSet({});
  for (let i = 0; i < 210; i++) step(true); // 4.2 s of packets lost
  run(1000);
  assert.equal(firmware.status, 2);
  assert.equal(machine.state, STATES.RECORDING);
});

test("start set: moderate packet loss during calibration does not stall the app", async () => {
  const { machine, run } = setup();
  machine.bleConnected();
  run(100);
  await machine.startSet({});
  run(6000, 3); // every 3rd packet lost
  assert.equal(machine.state, STATES.RECORDING);
});

test("calibration completes well inside the app's 15 s timeout", async () => {
  const { machine, run } = setup();
  machine.bleConnected();
  await machine.startSet({});
  run(CALIBRATION_MS + 500);
  assert.equal(machine.state, STATES.RECORDING);
  assert.equal(machine.stalled, false);
});

test("calibration failure (status 3) returns to idle with an error", async () => {
  const { machine, run } = setup({ failCalibration: true });
  machine.bleConnected();
  run(100);
  await machine.startSet({});
  run(CALIBRATION_MS + 200);
  assert.equal(machine.state, STATES.IDLE);
  assert.match(machine.snapshot().error, /calibration/i);
  assert.equal(machine.session, null);
});

test("retry after a failed calibration works", async () => {
  const { machine, run, firmware } = setup({ failCalibration: true });
  machine.bleConnected();
  await machine.startSet({});
  run(CALIBRATION_MS + 200);
  assert.equal(machine.state, STATES.IDLE);
  firmware.failCalibration = false;
  await machine.startSet({});
  run(CALIBRATION_MS + 200);
  assert.equal(machine.state, STATES.RECORDING);
});

test("stop reads the notify characteristic once and uses its rep count", async () => {
  const { machine, run, firmware } = setup();
  machine.bleConnected();
  await machine.startSet({});
  run(CALIBRATION_MS + 200);
  firmware.reps = 7;
  run(200);
  await machine.stop();
  assert.equal(machine.state, STATES.REVIEWING);
  assert.equal(machine.snapshot().repCount, 7);
});

test("disconnect mid-set goes to review with the captured data; disconnect while calibrating returns to disconnected", async () => {
  const mid = setup();
  mid.machine.bleConnected();
  await mid.machine.startSet({});
  mid.run(CALIBRATION_MS + 1000);
  mid.ble.connected = false;
  mid.machine.bleDisconnected();
  assert.equal(mid.machine.state, STATES.REVIEWING);
  assert.ok(mid.machine.session.samples.length > 0);

  const cal = setup();
  cal.machine.bleConnected();
  await cal.machine.startSet({});
  cal.run(1000);
  cal.ble.connected = false;
  cal.machine.bleDisconnected();
  assert.equal(cal.machine.state, STATES.DISCONNECTED);
});

test("idle disconnect and reconnect (firmware keeps advertising) resets cleanly", () => {
  const { machine, run } = setup();
  machine.bleConnected();
  run(100);
  machine.bleDisconnected();
  assert.equal(machine.state, STATES.DISCONNECTED);
  machine.bleConnected();
  run(100);
  assert.equal(machine.state, STATES.IDLE);
});

test("a stale 'calibrated' status from before the start command is not taken as a finished calibration", async () => {
  const { machine, run, firmware } = setup();
  machine.bleConnected();
  firmware.status = 2; // previous calibration still reported
  run(100);
  await machine.startSet({});
  run(2000); // v1 guarantee: next packet already says status 1, so the stale 2 never completes the wait
  assert.equal(machine.state, STATES.CALIBRATING);
});

test("an unknown future opcode on the control characteristic leaves a v1 firmware model undisturbed", async () => {
  const { machine, firmware, run } = setup();
  machine.bleConnected();
  await machine.ble.write(new Uint8Array([0x7e, 1, 2, 3]));
  run(200);
  assert.equal(firmware.status, 0);
  assert.equal(machine.state, STATES.IDLE);
});
