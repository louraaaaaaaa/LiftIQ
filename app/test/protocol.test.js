import assert from "node:assert/strict";
import test from "node:test";
import {
  createSessionCsv,
  decodeTelemetry,
  describeBattery,
  NOTIFY_HZ,
  packetToHex,
  DEVICE_FILTERS,
  DEVICE_NAME_PREFIX,
  LEGACY_DEVICE_NAME,
  estimateBatteryPercentage,
  encodeRepThresholds,
  NOTIFY_UUID,
  SERVICE_UUID,
  WRITE_UUID,
} from "../protocol.js";

function packet({ phase = 0, calibration = 0, reps = 0, batteryMillivolts = 3900, seq = 0 } = {}) {
  const buffer = new ArrayBuffer(18);
  const view = new DataView(buffer);
  [123, -234, 978, 979, 2].forEach((value, index) => view.setInt16(index * 2, value, true));
  view.setUint16(10, seq, true);
  view.setUint8(12, phase);
  view.setUint8(13, calibration);
  view.setUint16(14, reps, true);
  view.setUint16(16, batteryMillivolts, true);
  return view;
}

test("targets the current firmware's advertised BLE service and characteristics", () => {
  assert.equal(DEVICE_NAME_PREFIX, "LiftIQ");
  assert.equal(LEGACY_DEVICE_NAME, "GymIQ Sensor");
  assert.deepEqual(DEVICE_FILTERS, [
    { services: [SERVICE_UUID] },
    { namePrefix: "LiftIQ" },
    { name: "GymIQ Sensor" },
  ]);
  assert.equal(SERVICE_UUID, "4fa8691a-1365-4a4f-a808-3fda13b292e0");
  assert.equal(NOTIFY_UUID, "beb5483e-36e1-4688-b7f5-ea07361b26a8");
  assert.equal(WRITE_UUID, "cba8691a-1365-4a4f-a808-3fda13b292e0");
});

test("decodes the firmware's little-endian 18-byte notification", () => {
  assert.deepEqual(decodeTelemetry(packet({ phase: 2, reps: 260, seq: 65535 })), {
    ax: 1.23,
    ay: -2.34,
    az: 9.78,
    totalAccel: 9.79,
    dynamicAccel: 0.02,
    phase: 2,
    calibration: null,
    calibrationCode: 0,
    seq: 65535,
    repCount: 260,
    batteryMillivolts: 3900,
  });
});

test("decodes the uint16 sequence counter and treats 16-byte legacy packets as having none", () => {
  assert.equal(decodeTelemetry(packet({ seq: 0 })).seq, 0);
  assert.equal(decodeTelemetry(packet({ seq: 40000 })).seq, 40000);
  const legacy = decodeTelemetry(new DataView(packet({ seq: 7 }).buffer, 0, 16));
  assert.equal(legacy.seq, null);
  assert.equal(legacy.batteryMillivolts, null);
  assert.equal("velocity" in legacy, false);
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

test("estimates battery percentage linearly across a single-cell LiPo range", () => {
  assert.equal(estimateBatteryPercentage(3000), 0);
  assert.equal(estimateBatteryPercentage(3300), 0);
  assert.equal(estimateBatteryPercentage(3750), 50);
  assert.equal(estimateBatteryPercentage(4200), 100);
  assert.equal(estimateBatteryPercentage(4300), 100);
  assert.throws(() => estimateBatteryPercentage(Number.NaN), TypeError);
});

test("encodes rep thresholds as a little-endian BLE settings command", () => {
  const command = encodeRepThresholds({ start: 1.2, reversal: 0.4, rest: 0.6 });
  assert.deepEqual(Array.from(command), [0x02, 120, 0, 40, 0, 60, 0]);
  assert.throws(
    () => encodeRepThresholds({ start: 0, reversal: 0.4, rest: 0.6 }),
    RangeError
  );
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
    seq: 70001,
    actual_rep_count: 4,
    arrival_s: 0.2,
  }]);
  assert.match(csv, /elapsed_s,ax_m_s2,ay_m_s2,az_m_s2,total_accel_m_s2,dynamic_accel_m_s2,phase,phase_id,rep_count,seq,actual_rep_count,arrival_s/);
  assert.match(csv, /"CONCENTRIC, ""up"""/);
  assert.match(csv, /,3,70001,4,0.2\r\n/);
  assert.doesNotMatch(csv, /sample_rate/);
  assert.doesNotMatch(csv, /velocity_estimate/);
  assert.equal(csv.trimEnd().split("\r\n").length, 2);
});

test("persistent calibration status byte is exposed on every packet", () => {
  for (const [code, name] of [[0, null], [1, "started"], [2, "complete"], [3, "failed"]]) {
    const reading = decodeTelemetry(packet({ calibration: code }));
    assert.equal(reading.calibrationCode, code);
    assert.equal(reading.calibration, name);
  }
});

test("distinguishes waiting, no battery and valid battery readings", () => {
  assert.deepEqual(describeBattery(null), { kind: "waiting" });
  assert.deepEqual(describeBattery(undefined), { kind: "waiting" });
  assert.equal(describeBattery(0).kind, "none");
  assert.match(describeBattery(0).message, /USB.*sense not wired/);
  assert.equal(NOTIFY_HZ, 50);
  const ok = describeBattery(3750);
  assert.equal(ok.kind, "ok");
  assert.equal(ok.percent, 50);
  assert.equal(ok.volts, 3.75);
});

test("formats raw packets as hex for the debug panel", () => {
  const view = new DataView(new Uint8Array([0, 1, 255]).buffer);
  assert.equal(packetToHex(view), "00 01 ff");
});
