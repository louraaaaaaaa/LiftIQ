import assert from "node:assert/strict";
import test from "node:test";
import {
  createSessionCsv,
  decodeTelemetry,
  DEVICE_NAME,
  NOTIFY_UUID,
  SERVICE_UUID,
  WRITE_UUID,
} from "../protocol.js";

function packet({ phase = 0, calibration = 0, reps = 0, batteryMillivolts = 3900 } = {}) {
  const buffer = new ArrayBuffer(18);
  const view = new DataView(buffer);
  [123, -234, 978, 979, 2, 150].forEach((value, index) => view.setInt16(index * 2, value, true));
  view.setUint8(12, phase);
  view.setUint8(13, calibration);
  view.setUint16(14, reps, true);
  view.setUint16(16, batteryMillivolts, true);
  return view;
}

test("targets the current firmware's advertised BLE service and characteristics", () => {
  assert.equal(DEVICE_NAME, "GymIQ Sensor");
  assert.equal(SERVICE_UUID, "4fa8691a-1365-4a4f-a808-3fda13b292e0");
  assert.equal(NOTIFY_UUID, "beb5483e-36e1-4688-b7f5-ea07361b26a8");
  assert.equal(WRITE_UUID, "cba8691a-1365-4a4f-a808-3fda13b292e0");
});

test("decodes the firmware's little-endian 18-byte notification", () => {
  assert.deepEqual(decodeTelemetry(packet({ phase: 2, reps: 260 })), {
    ax: 1.23,
    ay: -2.34,
    az: 9.78,
    totalAccel: 9.79,
    dynamicAccel: 0.02,
    velocity: 0.15,
    phase: 2,
    calibration: null,
    repCount: 260,
    batteryMillivolts: 3900,
  });
});

test("returns calibration updates and rejects invalid packets", () => {
  assert.equal(decodeTelemetry(packet({ calibration: 2 })).calibration, "complete");
  const legacyPacket = packet();
  assert.equal(decodeTelemetry(new DataView(legacyPacket.buffer, 0, 16)).batteryMillivolts, null);
  assert.equal(decodeTelemetry(new DataView(new ArrayBuffer(15))), null);
  assert.equal(decodeTelemetry(new DataView(new ArrayBuffer(17))), null);
  assert.equal(decodeTelemetry(packet({ phase: 3 })), null);
  assert.equal(decodeTelemetry(packet({ calibration: 4 })), null);
});

test("writes every sample column and safely quotes CSV values", () => {
  const csv = createSessionCsv([{
    elapsed_s: 0.1,
    ax_m_s2: 1,
    ay_m_s2: 2,
    az_m_s2: 9,
    total_accel_m_s2: 9.3,
    dynamic_accel_m_s2: 0.5,
    phase: 'CONCENTRIC, "up"',
    phase_id: 1,
    rep_count: 3,
    actual_rep_count: 4,
  }]);
  assert.match(csv, /elapsed_s,ax_m_s2,ay_m_s2,az_m_s2,total_accel_m_s2,dynamic_accel_m_s2,phase,phase_id,rep_count,actual_rep_count/);
  assert.match(csv, /"CONCENTRIC, ""up"""/);
  assert.match(csv, /,3,4\r\n/);
  assert.doesNotMatch(csv, /sample_rate/);
  assert.doesNotMatch(csv, /velocity_estimate/);
  assert.equal(csv.trimEnd().split("\r\n").length, 2);
});
