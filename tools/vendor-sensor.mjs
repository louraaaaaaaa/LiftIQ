#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Vendor packages/liftiq-sensor/src into a consumer: <target>/liftiq-sensor/.
//
//   node tools/vendor-sensor.mjs --target app/dev/vendor           copy (replaces the folder)
//   node tools/vendor-sensor.mjs --target app/dev/vendor --check    exit 1 if the copy differs from the source
//
// Every .js file gets a first line "// VENDORED FROM packages/liftiq-sensor@<version> - do not edit"
// (files are normalised to LF so the result is identical on every OS). <target>/liftiq-sensor/VERSION.json
// records {version, sourceCommit: null, fileHashes} (sha256 of the normalised SOURCE files; the commit is
// deliberately not recorded: the tool never shells out to git and a dirty tree has no honest commit).
// Never edit the vendored copy: change packages/liftiq-sensor/src and run this tool again.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkgDir = join(repo, "packages", "liftiq-sensor");
const srcDir = join(pkgDir, "src");

function usage(message) {
  if (message) console.error(message);
  console.error("Usage: node tools/vendor-sensor.mjs --target <dir> [--check]");
  process.exit(2);
}

const args = process.argv.slice(2);
let target = null;
let check = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--target") target = args[++i];
  else if (args[i] === "--check") check = true;
  else usage(`Unknown argument: ${args[i]}`);
}
if (!target) usage("Missing --target <dir>.");

const outDir = join(resolve(process.cwd(), target), "liftiq-sensor");

function listFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...listFiles(full));
    else out.push(full);
  }
  return out;
}

const toLf = (text) => text.replace(/\r\n/g, "\n");
const sha256 = (text) => createHash("sha256").update(text).digest("hex");

function build() {
  const version = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")).version;
  const header = `// VENDORED FROM packages/liftiq-sensor@${version} — do not edit (run tools/vendor-sensor.mjs)\n`;
  const files = new Map(); // relative posix path -> content
  const fileHashes = {};
  for (const full of listFiles(srcDir)) {
    const rel = relative(srcDir, full).split(sep).join("/");
    const source = toLf(readFileSync(full, "utf8"));
    fileHashes[rel] = sha256(source);
    files.set(rel, rel.endsWith(".js") ? header + source : source);
  }
  files.set("VERSION.json", JSON.stringify({ version, sourceCommit: null, fileHashes }, null, 2) + "\n");
  return { version, files };
}

const { version, files } = build();

if (check) {
  const problems = [];
  if (!existsSync(outDir)) problems.push(`${outDir} does not exist`);
  else {
    const present = new Map(listFiles(outDir).map((f) => [relative(outDir, f).split(sep).join("/"), f]));
    for (const [rel, content] of files) {
      if (!present.has(rel)) problems.push(`missing: ${rel}`);
      else if (toLf(readFileSync(present.get(rel), "utf8")) !== content) problems.push(`differs from source: ${rel}`);
    }
    for (const rel of present.keys()) if (!files.has(rel)) problems.push(`stale (not in source): ${rel}`);
  }
  if (problems.length) {
    console.error(`Vendored copy in ${outDir} is out of date:`);
    for (const p of problems) console.error(`  ${p}`);
    console.error("Run: node tools/vendor-sensor.mjs --target " + target);
    process.exit(1);
  }
  console.log(`vendor check OK: ${files.size - 1} files match packages/liftiq-sensor@${version}`);
} else {
  rmSync(outDir, { recursive: true, force: true });
  for (const [rel, content] of files) {
    const dest = join(outDir, ...rel.split("/"));
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, content, "utf8");
  }
  console.log(`vendored packages/liftiq-sensor@${version}: ${files.size - 1} files -> ${outDir}`);
}
