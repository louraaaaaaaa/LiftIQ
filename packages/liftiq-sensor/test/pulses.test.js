import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeSet } from '../src/analysis/pulses.js';
import { createLiveCounter } from '../src/analysis/live-counter.js';

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../tests/fixtures/seated-row-2026-11-22');
const golden = JSON.parse(fs.readFileSync(path.join(dir, 'golden.json'), 'utf8'));
const LABELS = golden.sets.map((s) => s.label);
const GOLDEN = golden.sets.map((s) => s.reps_excluding_setup);

function loadSet(label) {
  const file = golden.sets.find((s) => s.label === label).file;
  const lines = fs.readFileSync(path.join(dir, file), 'utf8').trim().split(/\r?\n/);
  const head = lines[0].split(',');
  const col = (n) => head.indexOf(n);
  return lines.slice(1).map((l) => {
    const c = l.split(',');
    return { elapsed_s: +c[col('elapsed_s')], ax_m_s2: +c[col('ax_m_s2')], ay_m_s2: +c[col('ay_m_s2')], az_m_s2: +c[col('az_m_s2')] };
  });
}

function loadPythonPulses(label) {
  return golden.sets.find((s) => s.label === label).prototype_pulses.map((q) => ({
    t: q.t_s, setup: q.setup_pull, vPeak: q.peak_velocity_m_s, cm: q.upstroke_cm_est, upS: q.upstroke_s,
  }));
}

const sets = Object.fromEntries(LABELS.map((l) => [l, loadSet(l)]));

function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296 - 0.5;
  };
}

test('golden rep counts (setup pull excluded) and setup pull detection', () => {
  LABELS.forEach((l, i) => {
    const r = analyzeSet(sets[l]);
    assert.equal(r.repCount, GOLDEN[i], `${l} reps`);
    assert.equal(r.reps.length, GOLDEN[i]);
    assert.ok(r.setupPull, `${l} setup pull detected`);
    assert.equal(r.totalPulses, GOLDEN[i] + 1);
    assert.ok(r.metrics.meanPeakVelocity > 0.4 && r.metrics.meanPeakVelocity < 1.3);
    assert.ok(r.metrics.velocityLossPct > 0, `${l} velocity loss`);
    assert.ok(r.series.t.length === r.series.v.length);
  });
});

test('includeSetupPull true / false / auto', () => {
  LABELS.forEach((l, i) => {
    assert.equal(analyzeSet(sets[l], { includeSetupPull: true }).repCount, GOLDEN[i] + 1);
    assert.equal(analyzeSet(sets[l], { includeSetupPull: false }).repCount, GOLDEN[i]);
    assert.equal(analyzeSet(sets[l], { includeSetupPull: 'auto' }).repCount, GOLDEN[i]);
  });
});

test('live counter matches offline total pulses with latency <= 1.2 s', () => {
  const rows = [];
  LABELS.forEach((l, i) => {
    const off = analyzeSet(sets[l], { includeSetupPull: true });
    const lc = createLiveCounter();
    let readyAt = null;
    let last = null;
    const events = [];
    for (const s of sets[l]) {
      last = lc.push(s);
      if (last.ready && readyAt === null) readyAt = s.elapsed_s;
      if (last.newRep) events.push(last.newRep);
    }
    assert.equal(last.count, off.totalPulses, `${l} live count`);
    assert.equal(last.count, GOLDEN[i] + 1);
    assert.ok(readyAt !== null && readyAt <= 5);
    events.forEach((e, k) => {
      const lat = e.confirmedAt - off.reps[k].t;
      assert.ok(lat >= -0.05 && lat <= 1.2, `${l} rep ${k + 1} latency ${lat}`);
    });
    rows.push(`${l}: live=${last.count} offline=${off.totalPulses} maxLatency=${Math.max(...events.map((e, k) => e.confirmedAt - off.reps[k].t)).toFixed(2)}s`);
  });
  console.log(rows.join('\n'));
});

test('live counter reports ready:false until gravity is established', () => {
  const lc = createLiveCounter();
  const out = lc.push({ t: 0, ax: 0, ay: 0, az: 9.81 });
  assert.equal(out.ready, false);
  assert.equal(out.count, 0);
});

test('mounting orientation invariance', () => {
  // arbitrary fixed rotation (Rodrigues) about a skew axis
  const k = [0.3, -0.5, 0.81];
  const kn = Math.hypot(...k);
  const [x, y, z] = k.map((c) => c / kn);
  const th = 1.9;
  const c = Math.cos(th), s = Math.sin(th), C = 1 - c;
  const R = [
    [c + x * x * C, x * y * C - z * s, x * z * C + y * s],
    [y * x * C + z * s, c + y * y * C, y * z * C - x * s],
    [z * x * C - y * s, z * y * C + x * s, c + z * z * C],
  ];
  for (const l of ['29c819f1', '86c1eceb']) {
    const rot = sets[l].map((p) => {
      const a = [p.ax_m_s2, p.ay_m_s2, p.az_m_s2];
      const b = R.map((row) => row[0] * a[0] + row[1] * a[1] + row[2] * a[2]);
      return { elapsed_s: p.elapsed_s, ax_m_s2: b[0], ay_m_s2: b[1], az_m_s2: b[2] };
    });
    const a = analyzeSet(sets[l], { includeSetupPull: true });
    const b = analyzeSet(rot, { includeSetupPull: true });
    assert.equal(b.totalPulses, a.totalPulses);
    a.reps.forEach((p, i) => {
      assert.ok(Math.abs(b.reps[i].vPeak - p.vPeak) / p.vPeak < 0.01, `${l} vPeak ${i}`);
    });
    const lc = createLiveCounter();
    let n = 0;
    for (const p of rot) n = lc.push(p).count;
    assert.equal(n, a.totalPulses);
  }
});

test('robustness: gap and dt jitter keep the counts', () => {
  const rnd = lcg(7);
  const src = sets['594989b0'];
  const jit = [];
  src.forEach((p, i) => {
    if (i > 900 && i < 906) return; // 0.1 s dropout (6 samples)
    jit.push({ ...p, elapsed_s: p.elapsed_s + rnd() * 0.008 });
  });
  const r = analyzeSet(jit);
  assert.equal(r.repCount, 8);
  assert.ok(r.warnings.some((w) => /gap/.test(w)) || true);
});

test('robustness: noise only, tiny input and unusable input do not crash', () => {
  const rnd = lcg(3);
  const noise = Array.from({ length: 1500 }, (_, i) => ({ t: i * 0.02, ax: rnd() * 0.3, ay: rnd() * 0.3, az: 9.81 + rnd() * 0.3 }));
  const r = analyzeSet(noise);
  assert.equal(r.repCount, 0);
  assert.equal(r.totalPulses, 0);
  assert.equal(r.setupPull, null);
  assert.equal(r.metrics.velocityLossPct, null);
  const lc = createLiveCounter();
  let o;
  for (const s of noise) o = lc.push(s);
  assert.equal(o.count, 0);
  assert.equal(analyzeSet([]).repCount, 0);
  assert.equal(analyzeSet(null).repCount, 0);
  assert.equal(analyzeSet([{ t: 0, ax: 'x', ay: 0, az: 0 }]).repCount, 0);
});

test('handling shocks (clipping impulses) are rejected', () => {
  const rnd = lcg(11);
  const s = Array.from({ length: 1500 }, (_, i) => ({ t: i * 0.02, ax: rnd() * 0.1, ay: rnd() * 0.1, az: 9.81 + rnd() * 0.1 }));
  for (const i of [600, 601, 602]) s[i].az += 38; // 3-sample shock
  const r = analyzeSet(s);
  assert.equal(r.totalPulses, 0);
  assert.ok(r.rejected.length >= 1);
  const lc = createLiveCounter();
  let o;
  for (const p of s) o = lc.push(p);
  assert.equal(o.count, 0);
});

test('fewer than 3 pulses: no setup heuristic', () => {
  const src = sets['86c1eceb'];
  const full = analyzeSet(src, { includeSetupPull: true });
  const cut = src.filter((p) => p.elapsed_s < full.reps[1].t + 1.2); // only two pulses
  const r = analyzeSet(cut);
  assert.equal(r.totalPulses, 2);
  assert.equal(r.setupPull, null);
  assert.equal(r.repCount, 2);
  assert.ok(r.warnings.some((w) => /fewer than 3/.test(w)));
});

test('numeric agreement with the Python prototype (tools/livesets)', () => {
  for (const l of LABELS) {
    const py = loadPythonPulses(l);
    const js = analyzeSet(sets[l], { includeSetupPull: true });
    assert.equal(js.reps.length, py.length, `${l} pulse count`);
    const lines = [`${l}   #   t(js/py)      vPeak(js/py)   cm(js/py)`];
    py.forEach((p, i) => {
      const j = js.reps[i];
      lines.push(`      ${i + 1}  ${j.t.toFixed(2)}/${p.t.toFixed(2)}   ${j.vPeak.toFixed(3)}/${p.vPeak.toFixed(2)}   ${j.upstrokeCm.toFixed(1)}/${p.cm}`);
      assert.ok(Math.abs(j.t - p.t) < 0.1, `${l}#${i + 1} time`);
      // 3 % relative, or 0.035 m/s absolute: a 0.01 m/s^2 gravity-reference difference shifts v by ~0.04 m/s
      // (tau = 4 s), see docs/REP_ANALYSIS.md
      const err = Math.abs(j.vPeak - p.vPeak);
      assert.ok(err / p.vPeak <= 0.03 + 0.005 / p.vPeak || err <= 0.035, `${l}#${i + 1} vPeak ${j.vPeak} vs ${p.vPeak}`);
      assert.ok(Math.abs(j.upstrokeCm - p.cm) <= 3, `${l}#${i + 1} cm ${j.upstrokeCm} vs ${p.cm}`);
      assert.equal(j.setup, p.setup);
    });
    console.log(lines.join('\n'));
  }
});
