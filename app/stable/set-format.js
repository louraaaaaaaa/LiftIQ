// Human-readable names and the per-set CSV (format: liftiq-set v1). Pure functions.
import { slugify } from "./exercises.js";
import { analyzeSet } from "./analysis/pulses.js";
import { CSV_COLUMNS } from "./protocol.js";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const p2 = (n) => String(n).padStart(2, "0");

export function hasWeight(kg) {
  return kg !== null && kg !== undefined && kg !== "" && Number.isFinite(Number(kg));
}

/** "42.5"; empty string when the weight is unknown. */
export function formatWeight(kg) {
  return hasWeight(kg) ? String(Math.round(Number(kg) * 100) / 100) : "";
}

export function formatDateTime(iso) {
  const d = new Date(iso);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

export function localDate(iso) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}

export function repsText(n) {
  return `${n} ${n === 1 ? "rep" : "reps"}`;
}

/** "Seated cable row · Set 2 · 45 kg · 8 reps · 22 Nov 2026 14:05" (weight omitted when unknown). */
export function setLabel(set) {
  return [
    set.exerciseName, `Set ${set.setNumber}`, hasWeight(set.weightKg) ? `${formatWeight(set.weightKg)} kg` : null,
    repsText(set.repsConfirmed), formatDateTime(set.startedAt),
  ].filter(Boolean).join(" · ");
}

function baseFileName(set) {
  return `liftiq_${localDate(set.startedAt)}_${slugify(set.exerciseName)}_set${set.setNumber}`;
}

/** liftiq_2026-11-22_seated-cable-row_set2.csv ; `taken` = names already used (adds _2, _3, ...). */
export function setFileName(set, taken = []) {
  const used = new Set(taken);
  const base = baseFileName(set);
  let name = `${base}.csv`;
  for (let i = 2; used.has(name); i++) name = `${base}_${i}.csv`;
  return name;
}

/** Map set id -> unique file name; the earliest set keeps the plain name. */
export function uniqueSetFileNames(sets) {
  const out = new Map();
  const taken = [];
  for (const s of [...sets].sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)))) {
    const name = setFileName(s, taken);
    taken.push(name);
    out.set(s.id, name);
  }
  return out;
}

function cell(value) {
  const text = value === undefined || value === null ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

const num = (x, d) => (Number.isFinite(x) ? Number(x.toFixed(d)) : "");

/** Vertical acceleration and velocity aligned to the stored samples (by timestamp). */
export function verticalSeries(samples, analysis = analyzeSet(samples)) {
  const byTime = new Map();
  analysis.series.t.forEach((t, i) => byTime.set(t, i));
  return samples.map((s) => {
    const i = byTime.get(Number(s.elapsed_s ?? s.t));
    return i === undefined ? { a: NaN, v: NaN } : { a: analysis.series.aVert[i], v: analysis.series.v[i] };
  });
}

export function buildSetCsv(set, samples, analysis = analyzeSet(samples)) {
  const header = [
    ["format", "liftiq-set v1"],
    ["exercise", set.exerciseName],
    ["weight_kg", formatWeight(set.weightKg)], // empty when unknown
    ["set_number", set.setNumber],
    ["reps_detected_with_setup", set.repsDetectedWithSetup],
    ["reps_detected_excluding_setup", set.repsDetectedExcludingSetup],
    ["setup_pull_flagged", set.setupPullFlagged ? "yes" : "no"],
    ["setup_pull_included", set.setupPullIncluded ? "yes" : "no"],
    ["reps_confirmed", set.repsConfirmed],
    ["reps_source", set.repsSource],
    ["firmware_version", set.firmwareVersion ?? ""],
    ["app_version", set.appVersion ?? ""],
    ["sensor_name", set.sensorName ?? ""],
    ["captured_at", set.startedAt],
    ["note", String(set.note ?? "").replace(/[\r\n]+/g, " ")],
  ].map(([k, v]) => `# ${k}: ${v}`);
  const vert = verticalSeries(samples, analysis);
  const columns = [...CSV_COLUMNS, "vert_accel_m_s2", "vert_velocity_m_s"];
  const rows = samples.map((s, i) => columns.map((c) => {
    if (c === "actual_rep_count") return cell(set.repsConfirmed);
    if (c === "vert_accel_m_s2") return cell(num(vert[i].a, 3));
    if (c === "vert_velocity_m_s") return cell(num(vert[i].v, 3));
    return cell(s[c]);
  }).join(","));
  return [...header, columns.join(","), ...rows].join("\r\n") + "\r\n";
}
