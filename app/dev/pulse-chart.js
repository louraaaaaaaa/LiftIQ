// Vertical-velocity chart with numbered pulses, as an SVG string (pure, styled by styles.css .pc-*).

/** Every detected pulse of an analysis result (setup pull first), without duplicates. */
export function allPulses(analysis) {
  const seen = new Set();
  return [analysis.setupPull, ...analysis.reps].filter((p) => p && !seen.has(p.n) && seen.add(p.n));
}

export function pulseChartSvg(series, pulses, { width = 640, height = 220, includeSetup = false } = {}) {
  const t = series?.t ?? [];
  const v = series?.v ?? [];
  const list = (pulses || []).filter(Boolean);
  const pad = { l: 34, r: 8, t: 10, b: 22 };
  const w = width - pad.l - pad.r;
  const h = height - pad.t - pad.b;
  const open = `<svg class="pulse-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Vertical velocity of the plate during the set, with each detected pull numbered" preserveAspectRatio="xMidYMid meet">`;
  if (t.length < 2) return `${open}<text class="pc-axis" x="${width / 2}" y="${height / 2}" text-anchor="middle">No data</text></svg>`;

  const t0 = t[0];
  const t1 = t[t.length - 1];
  let vMin = -0.5;
  let vMax = 0.5;
  for (const x of v) { if (x > vMax) vMax = x; if (x < vMin) vMin = x; }
  vMax *= 1.15;
  vMin *= 1.1;
  const X = (x) => pad.l + ((x - t0) / (t1 - t0)) * w;
  const Y = (y) => pad.t + (1 - (y - vMin) / (vMax - vMin)) * h;

  const step = Math.max(1, Math.floor(t.length / 700));
  const pts = [];
  for (let i = 0; i < t.length; i += step) pts.push(`${X(t[i]).toFixed(1)},${Y(v[i]).toFixed(1)}`);

  let out = open;
  // axis: zero line, +-0.5 m/s grid, time ticks
  out += `<line class="pc-zero" x1="${pad.l}" x2="${width - pad.r}" y1="${Y(0).toFixed(1)}" y2="${Y(0).toFixed(1)}"/>`;
  for (const g of [0.5, 1]) {
    if (g < vMax) out += `<line class="pc-grid" x1="${pad.l}" x2="${width - pad.r}" y1="${Y(g).toFixed(1)}" y2="${Y(g).toFixed(1)}"/><text class="pc-axis" x="${pad.l - 4}" y="${(Y(g) + 3).toFixed(1)}" text-anchor="end">${g}</text>`;
  }
  out += `<text class="pc-axis" x="${pad.l - 4}" y="${(Y(0) + 3).toFixed(1)}" text-anchor="end">0</text>`;
  const tickStep = (t1 - t0) > 60 ? 10 : 5;
  for (let s = Math.ceil(t0 / tickStep) * tickStep; s < t1; s += tickStep) {
    out += `<text class="pc-axis" x="${X(s).toFixed(1)}" y="${height - 6}" text-anchor="middle">${s}s</text>`;
  }
  out += `<text class="pc-axis" x="2" y="${pad.t + 8}">m/s</text>`;

  let counted = 0;
  for (const p of list) {
    const excluded = Boolean(p.setup) && !includeSetup;
    const cls = p.setup ? "pc-setup" : "pc-rep";
    out += `<rect class="pc-band ${cls}" x="${X(p.tStart).toFixed(1)}" y="${pad.t}" width="${Math.max(1, X(p.tEnd) - X(p.tStart)).toFixed(1)}" height="${h}"/>`;
  }
  out += `<polyline class="pc-line" points="${pts.join(" ")}"/>`;
  for (const p of list) {
    const excluded = Boolean(p.setup) && !includeSetup;
    const label = excluded ? "S" : String(++counted);
    const x = X(p.t);
    const y = Y(p.vPeak);
    out += `<circle class="pc-dot ${p.setup ? "pc-setup" : "pc-rep"}" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3.5"/>`;
    out += `<text class="pc-label ${p.setup ? "pc-setup" : "pc-rep"}" x="${x.toFixed(1)}" y="${(y - 7).toFixed(1)}" text-anchor="middle">${label}</text>`;
  }
  return `${out}</svg>`;
}
