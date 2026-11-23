#!/usr/bin/env node
// Builds the compact exercise index for the LiftIQ dev app from the open dataset
// https://github.com/hasaneyldrm/exercises-dataset (data/exercises.json, MIT for data and text).
// No dependencies. Usage:
//   node tools/exercise-db/build-index.mjs <path/to/exercises.json> <commit-sha> [outDir] [--license <path/to/LICENSE>]
// Writes exercises.min.json, meta.json and (when --license is given) LICENSE-exercises-dataset.txt to outDir
// (default app/dev/assets/exercise-db). English only; media is NEVER copied, only file names are kept.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SOURCE_REPO = "https://github.com/hasaneyldrm/exercises-dataset";
export const MEDIA_NOTICE = "\u00A9 Gym visual \u2014 https://gymvisual.com/";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** Fix the few names the dataset has with a mojibake degree sign ("45в°" -> "45°"). */
export const cleanName = (name) => String(name ?? "").replace(/в°/g, "\u00B0").replace(/\s+/g, " ").trim();

/**
 * Pure: dataset records -> compact records.
 * Short keys: i id, n name, c category, b body_part, e equipment, t target, g muscle_group, s secondary_muscles,
 * st English instruction steps, m media_id, im/gf image/gif file names ONLY when they differ from <id>-<m>.jpg/.gif.
 */
export function compactRecords(raw) {
  if (!Array.isArray(raw)) throw new Error("exercises.json must be an array");
  const seen = new Set();
  return raw.map((r) => {
    const id = String(r.id ?? "").trim();
    if (!id || seen.has(id)) throw new Error(`missing or duplicate id: ${id}`);
    seen.add(id);
    const name = cleanName(r.name);
    if (!name) throw new Error(`exercise ${id} has no name`);
    const steps = (r.instruction_steps?.en ?? []).map((s) => String(s).trim()).filter(Boolean);
    const media = String(r.media_id ?? "").trim();
    const image = String(r.image ?? "").replace(/^images\//, "");
    const gif = String(r.gif_url ?? "").replace(/^videos\//, "");
    const out = { i: id, n: name, c: r.category || "", b: r.body_part || "", e: r.equipment || "", t: r.target || "", g: r.muscle_group || "", s: (r.secondary_muscles ?? []).filter(Boolean), st: steps, m: media };
    if (image !== `${id}-${media}.jpg`) out.im = image;
    if (gif !== `${id}-${media}.gif`) out.gf = gif;
    return out;
  });
}

export function buildIndex(raw, sha, { now = () => new Date().toISOString() } = {}) {
  if (!/^[0-9a-f]{40}$/.test(String(sha))) throw new Error("sha must be a 40 character commit hash (pin the dataset commit)");
  const items = compactRecords(raw);
  const meta = {
    sha, count: items.length, generatedAt: now(), sourceUrl: SOURCE_REPO, dataLicense: "MIT", mediaNotice: MEDIA_NOTICE,
  };
  return { items, meta };
}

function main(argv) {
  const args = argv.slice(2);
  const licenseAt = args.indexOf("--license");
  const licensePath = licenseAt >= 0 ? args.splice(licenseAt, 2)[1] : null;
  const [input, sha, outArg] = args;
  if (!input || !sha) {
    console.error("usage: node tools/exercise-db/build-index.mjs <exercises.json> <commit-sha> [outDir] [--license <LICENSE file>]");
    process.exit(2);
  }
  const outDir = path.resolve(outArg || path.join(ROOT, "app/dev/assets/exercise-db"));
  const { items, meta } = buildIndex(JSON.parse(fs.readFileSync(input, "utf8")), sha);
  fs.mkdirSync(outDir, { recursive: true });
  const body = JSON.stringify(items);
  fs.writeFileSync(path.join(outDir, "exercises.min.json"), body);
  fs.writeFileSync(path.join(outDir, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`);
  if (licensePath) {
    // MIT text and copyright line only (the media exception paragraph is kept too: it is part of the file).
    fs.writeFileSync(path.join(outDir, "LICENSE-exercises-dataset.txt"), fs.readFileSync(licensePath, "utf8"));
  }
  console.log(`${meta.count} exercises, ${body.length} bytes raw -> ${outDir}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv);
