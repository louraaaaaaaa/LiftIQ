// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createStillnessDetector } from "../src/ready-check.js";
import { analyzeSet } from "../src/analysis/pulses.js";

const fixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../tests/fixtures/seated-row-2026-11-22");
const golden = JSON.parse(fs.readFileSync(path.join(fixtures, "golden.json"), "utf8"));
function load(file) {
  const lines = fs.readFileSync(path.join(fixtures, file), "utf8").trim().split(/\r?\n/).slice(1);
  return lines.map((l) => { const c = l.split(","); return { t: +c[0], ax: +c[1], ay: +c[2], az: +c[3] }; });
}

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
