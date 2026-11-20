// (ii) Compile the REAL firmware encoder (firmware/LiftIQ_BLE/protocol_v1.h) for the host and
// assert its bytes equal the golden vectors byte for byte.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { GOLDEN, REPO, bytesToHex, hexToBytes } from "./helpers.js";

function findCompiler() {
  const candidates = [process.env.LIFTIQ_CXX, "g++", "c++", "clang++", "C:/Strawberry/c/bin/g++.exe"].filter(Boolean);
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ["--version"], { encoding: "utf8" });
    if (!probe.error && probe.status === 0) return candidate;
  }
  return null;
}

const compiler = findCompiler();
const source = resolve(REPO, "tests/compat/host/encode_v1.cpp");

if (!compiler && process.env.CI) {
  test("host-compiled firmware encoder", () => assert.fail("CI requires g++ (apt-get install g++)"));
} else {
  test("host-compiled firmware encoder matches the golden vectors byte for byte", { skip: compiler ? false : "no C++ compiler (g++/clang++) found: install one or set LIFTIQ_CXX; CI always runs this" }, () => {
    const dir = mkdtempSync(join(tmpdir(), "liftiq-encode-"));
    try {
      const exe = join(dir, process.platform === "win32" ? "encode_v1.exe" : "encode_v1");
      const build = spawnSync(compiler, ["-std=c++11", "-Wall", "-Wextra", "-Werror", "-o", exe, source], { encoding: "utf8" });
      assert.equal(build.status, 0, `compile failed:\n${build.stdout}\n${build.stderr}`);

      const lines = [];
      for (const v of GOLDEN.telemetryV1) {
        const i = v.input;
        lines.push(`T ${v.name} ${i.ax} ${i.ay} ${i.az} ${i.totalAccel} ${i.dynamicAccel} ${i.seq} ${i.phase} ${i.calibrationStatus} ${i.repCount} ${i.batteryMillivolts}`);
      }
      for (const v of GOLDEN.infoV1) {
        const i = v.input;
        lines.push(`I ${v.name} ${i.protocolMajor} ${i.protocolMinor} ${i.capabilities} ${i.firmware}`);
      }
      const run = spawnSync(exe, [], { input: lines.join("\n") + "\n", encoding: "utf8" });
      assert.equal(run.status, 0, run.stderr);
      const produced = new Map(run.stdout.trim().split(/\r?\n/).map((line) => line.split(" ")));
      for (const v of [...GOLDEN.telemetryV1, ...GOLDEN.infoV1]) {
        assert.ok(produced.has(v.name), `encoder produced no output for ${v.name}`);
        assert.equal(bytesToHex(hexToBytes(produced.get(v.name))), bytesToHex(hexToBytes(v.hex)), v.name);
      }
      assert.ok(existsSync(exe));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
