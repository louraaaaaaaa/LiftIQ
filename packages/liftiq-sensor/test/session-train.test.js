// SPDX-License-Identifier: AGPL-3.0-or-later
// SessionMachine paths used by the Train flow: startWithoutCalibration / abort / releaseReview.
import assert from "node:assert/strict";
import test from "node:test";
import { SessionMachine, STATES, START_COMMAND } from "../src/session.js";

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


test("releaseReview hands the reviewed session over once and returns to idle", () => {
  const { session } = realSession();
  session.bleConnected();
  session.startWithoutCalibration({ exercise: "Row" });
  session.onReading({ calibrationCode: 0, ax: 0, ay: 0, az: 9.8, totalAccel: 9.8, dynamicAccel: 0, phase: 0, repCount: 0 }, { seq: 1 });
  session.bleDisconnected();
  assert.equal(session.state, STATES.REVIEWING);
  const released = session.releaseReview();
  assert.equal(released.samples.length, 1);
  assert.equal(session.session, null);
  assert.notEqual(session.state, STATES.REVIEWING);
  assert.equal(session.releaseReview(), null);
});
