// SPDX-License-Identifier: AGPL-3.0-or-later
// Guards the package contract: one public entry, framework/DOM/dependency-free sources, licence fields.
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import * as sensor from "../src/index.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));

function sources(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? sources(full) : [full];
  });
}

test("package.json: name, version, module type, licence, test script", () => {
  assert.equal(pkg.name, "@liftiq/sensor");
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
  assert.equal(pkg.type, "module");
  assert.equal(pkg.license, "AGPL-3.0-or-later");
  assert.match(pkg.scripts.test, /node --test/);
  assert.equal(pkg.dependencies, undefined);
});

test("index.js exports the public API", () => {
  for (const name of [
    "decodeTelemetry", "describeBattery", "estimateBatteryPercentage", "createSessionCsv", "encodeRepThresholds", "parseInfo",
    "PacketTracker", "SessionMachine", "STATES", "createStillnessDetector", "analyzeSet", "createLiveCounter",
    "BleClient", "WebBluetoothTransport", "parseRawChunk", "NOTIFY_HZ", "SERVICE_UUID",
  ]) assert.ok(name in sensor, `missing export ${name}`);
});

test("every package.json export entry points to an existing file", () => {
  for (const target of Object.values(pkg.exports)) assert.ok(statSync(path.join(root, target)).isFile(), target);
});

test("sources use only relative imports and no DOM/storage globals", () => {
  for (const file of sources(path.join(root, "src"))) {
    const text = readFileSync(file, "utf8");
    assert.match(text, /SPDX-License-Identifier: AGPL-3\.0-or-later/, `${file} lacks the SPDX line`);
    for (const m of text.matchAll(/(?:^|\n)\s*(?:import|export)[^"'\n]*?from\s+["']([^"']+)["']/g)) {
      assert.ok(m[1].startsWith("./") || m[1].startsWith("../"), `${file} imports ${m[1]}`);
    }
    assert.doesNotMatch(text, /\b(document|localStorage|sessionStorage|indexedDB)\b\s*[.[]/, `${file} touches a DOM/storage global`);
    assert.doesNotMatch(text, /\bwindow\./, `${file} touches window`);
  }
});
