// (i) Every golden vector must decode to the expected values with the STABLE app's decoder
// (the contract) and with the DEV app's decoder (must never regress against the contract).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { decodeTelemetry as decodeStable } from "../../app/stable/protocol.js";
import { decodeTelemetry as decodeDev, parseInfo } from "../../app/dev/protocol.js";
import { buildSelftestHeader, HEADER_PATH } from "./tools/gen-selftest-header.mjs";
import { GOLDEN, hexToBytes, hexToView } from "./helpers.js";

const decoders = { stable: decodeStable, dev: decodeDev };

for (const [label, decode] of Object.entries(decoders)) {
  for (const vector of [...GOLDEN.telemetryV1, ...GOLDEN.telemetryLegacy16]) {
    test(`${label} decoder: ${vector.name}`, () => {
      const decoded = decode(hexToView(vector.hex));
      assert.ok(decoded, "decoder returned null for a valid v1 packet");
      for (const [key, expected] of Object.entries(vector.decoded)) {
        assert.equal(decoded[key], expected, `${vector.name}.${key}`);
      }
    });
  }
  for (const vector of GOLDEN.telemetryInvalid) {
    test(`${label} decoder rejects: ${vector.name}`, () => {
      assert.equal(decode(hexToView(vector.hex)), null);
    });
  }
}

test("golden file is well formed: lengths, unique names, required kinds covered", () => {
  const names = GOLDEN.telemetryV1.map((v) => v.name);
  assert.equal(new Set(names).size, names.length);
  for (const v of GOLDEN.telemetryV1) assert.equal(hexToBytes(v.hex).length, 18, v.name);
  for (const v of GOLDEN.telemetryLegacy16) assert.equal(hexToBytes(v.hex).length, 16, v.name);
  for (const v of GOLDEN.infoV1) assert.equal(hexToBytes(v.hex).length, 20, v.name);
  const need = ["idle_at_rest", "concentric_rep3", "eccentric_rep3", "calibrating_status1", "calibrated_status2", "failed_status3",
    "battery_unavailable_0mv", "battery_4150mv", "seq_65535", "seq_wrapped_0", "reps_300", "accel_max_32767", "accel_min_32768"];
  for (const name of need) assert.ok(names.includes(name), `missing golden vector ${name}`);
});

test("dev app decodes the INFO golden vectors", () => {
  for (const vector of GOLDEN.infoV1) {
    assert.deepEqual(parseInfo(hexToView(vector.hex)), vector.decoded, vector.name);
  }
});

test("firmware boot self-test header is in sync with the golden vectors", () => {
  const onDisk = readFileSync(HEADER_PATH, "utf8").replace(/\r\n/g, "\n");
  assert.equal(onDisk, buildSelftestHeader(GOLDEN),
    "firmware/LiftIQ_BLE/protocol_v1_selftest_vectors.h is stale: run node tests/compat/tools/gen-selftest-header.mjs");
});
