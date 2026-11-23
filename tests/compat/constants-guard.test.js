// (iv) Static guard: the constants the released app depends on must be identical in the firmware
// sketch, the stable app and the dev app. Also pins the live-telemetry configuration that the
// RAW/Lab features must never alter ("dormant unless invoked", docs/PROTOCOL.md).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import * as stable from "../../app/stable/protocol.js";
import * as dev from "../../app/dev/protocol.js";
import { INO_PATH, PROTOCOL_HEADER_PATH, REPO } from "./helpers.js";

const ino = readFileSync(INO_PATH, "utf8");
const header = readFileSync(PROTOCOL_HEADER_PATH, "utf8");
const stableSource = readFileSync(resolve(REPO, "app/stable/protocol.js"), "utf8");

function define(name) {
  const match = ino.match(new RegExp(`#define\\s+${name}\\s+"([^"]+)"`));
  assert.ok(match, `#define ${name} not found in LiftIQ_BLE.ino`);
  return match[1].toLowerCase();
}

function constNumber(source, name) {
  const match = source.match(new RegExp(`(?:const|constexpr)\\s+(?:[A-Za-z0-9_]+\\s+)?${name}\\s*=\\s*([0-9A-Fa-fxX]+)`));
  assert.ok(match, `constant ${name} not found`);
  return Number(match[1]);
}

test("UUIDs: firmware sketch == stable app == dev app", () => {
  assert.equal(define("SERVICE_UUID"), stable.SERVICE_UUID);
  assert.equal(define("NOTIFY_CHARACTERISTIC_UUID"), stable.NOTIFY_UUID);
  assert.equal(define("WRITE_CHARACTERISTIC_UUID"), stable.WRITE_UUID);
  assert.equal(stable.SERVICE_UUID, dev.SERVICE_UUID);
  assert.equal(stable.NOTIFY_UUID, dev.NOTIFY_UUID);
  assert.equal(stable.WRITE_UUID, dev.WRITE_UUID);
});

test("dev-only characteristics (RAW, INFO): firmware == dev app, absent from stable, all UUIDs distinct", () => {
  assert.equal(define("RAW_CHARACTERISTIC_UUID"), dev.RAW_UUID);
  assert.equal(define("INFO_CHARACTERISTIC_UUID"), dev.INFO_UUID);
  const all = [stable.SERVICE_UUID, stable.NOTIFY_UUID, stable.WRITE_UUID, dev.RAW_UUID, dev.INFO_UUID];
  assert.equal(new Set(all).size, all.length);
});

test("advertising: service UUID is advertised and the name prefix matches the app filters", () => {
  assert.match(ino, /addServiceUUID\(SERVICE_UUID\)/);
  assert.match(ino, /"LiftIQ-%02X%02X"/);
  assert.match(ino, /char bleDeviceName\[\d+\] = "LiftIQ"/);
  for (const app of [stable, dev]) {
    assert.equal(app.DEVICE_NAME_PREFIX, "LiftIQ");
    assert.equal(app.LEGACY_DEVICE_NAME, "GymIQ Sensor");
    assert.deepEqual(app.DEVICE_FILTERS[0], { services: [app.SERVICE_UUID] });
    assert.ok(app.DEVICE_FILTERS.some((f) => f.namePrefix === "LiftIQ"));
  }
});

test("packet length 18 in firmware header, stable app and the sensor package (source of the dev app)", () => {
  assert.match(header, /#define\s+LIFTIQ_TELEMETRY_V1_LENGTH\s+18\b/);
  assert.match(stableSource, /const PACKET_LENGTH = 18;/);
  assert.match(readFileSync(resolve(REPO, "packages/liftiq-sensor/src/protocol.js"), "utf8"), /const PACKET_LENGTH = 18;/);
  assert.match(ino, /uint8_t payload\[LIFTIQ_TELEMETRY_V1_LENGTH\]/);
});

test("calibration status values 0..3 agree between firmware and apps", () => {
  assert.match(ino, /CALIBRATION_IDLE = 0/);
  assert.match(ino, /CALIBRATION_STARTED = 1/);
  assert.match(ino, /CALIBRATION_COMPLETE = 2/);
  assert.match(ino, /CALIBRATION_FAILED = 3/);
  assert.match(stableSource, /\[0, null\], \[1, "started"\], \[2, "complete"\], \[3, "failed"\]/);
});

test("control opcodes: 0x01 start/calibrate and 0x02 (7-byte thresholds) as the stable app sends them", () => {
  assert.match(ino, /command == 0x01/);
  assert.match(ino, /command == 0x02 && length == 7/);
  assert.deepEqual(Array.from(stable.encodeRepThresholds({ start: 1, reversal: 0.35, rest: 0.45 })), [2, 100, 0, 35, 0, 45, 0]);
});

test("live telemetry configuration is pinned: 50 Hz notifications, 100 Hz sampling, +/-8 g, ODR 0x28 (RAW must not change it)", () => {
  assert.equal(constNumber(ino, "SAMPLE_PERIOD_US"), 10000);
  assert.equal(constNumber(ino, "NOTIFY_EVERY_N_SAMPLES"), 2);
  assert.equal(constNumber(ino, "BMI160_ACC_CONF_VALUE"), 0x28);
  assert.equal(constNumber(ino, "BMI160_ACC_RANGE_VALUE"), 0x08);
  assert.equal(constNumber(ino, "ACCEL_RANGE_G"), 8);
  assert.equal(stable.NOTIFY_HZ, 50);
  assert.equal(dev.NOTIFY_HZ, 50);
  assert.equal(1e6 / constNumber(ino, "SAMPLE_PERIOD_US") / constNumber(ino, "NOTIFY_EVERY_N_SAMPLES"), stable.NOTIFY_HZ);
});

test("firmware protocol header: version constants and only portable includes", () => {
  assert.match(header, /#define\s+LIFTIQ_PROTOCOL_MAJOR\s+1\b/);
  const includes = [...header.matchAll(/#include\s+<([^>]+)>/g)].map((m) => m[1]).sort();
  assert.deepEqual(includes, ["math.h", "stdint.h", "string.h"]);
  assert.doesNotMatch(header, /#include\s+"/);
});

test("the sketch encodes telemetry through protocol_v1.h and serves the INFO characteristic read-only", () => {
  assert.match(ino, /#include "protocol_v1\.h"/);
  assert.match(ino, /encodeTelemetryV1\(payload, telemetry\)/);
  assert.match(ino, /encodeInfoV1\(info,/);
  assert.match(ino, /INFO_CHARACTERISTIC_UUID,\s*BLECharacteristic::PROPERTY_READ\s*\)/);
});

test("experimental opcodes 0x10-0x15 are the only extra opcodes the sketch acts on, and unknown opcodes fall through", () => {
  const handled = [...ino.matchAll(/command\s*(?:==|>=|<=)\s*(0x[0-9a-fA-F]+)/g)].map((m) => Number(m[1]));
  for (const code of handled) assert.ok([0x01, 0x02, 0x10, 0x15].includes(code), `unexpected opcode 0x${code.toString(16)} handled in onWrite`);
});
