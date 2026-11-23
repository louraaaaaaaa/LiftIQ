#!/usr/bin/env node
// Promote app/dev to app/stable (the app GitHub Pages publishes).
//
//   node tools/release-app.mjs --version 1.2.0 [--dry-run]
//   (from app/:  npm run release -- --version 1.2.0 --dry-run)
//
// Steps (it aborts on the first failure and NEVER commits or pushes):
//   1. run the dev unit tests and tests/compat (protocol gates) - must be green
//   2. refuse to run if app/stable has uncommitted changes (or the git repo is unavailable)
//   3. build the stable app from app/dev: copy, drop dev-only files, strip the DEV badge/branding,
//      rewrite channel.js (CHANNEL "stable", APP_VERSION = --version), manifest, title, theme colour
//   4. write app/stable/VERSION and bump the stable service-worker cache name (liftiq-app-vN+1)
//   5. run the stable unit tests on the result and print the next steps (review diff, commit, push)
//
// Options: --version X.Y.Z (required, must be higher than app/stable/VERSION)
//          --dry-run       build and verify in a temp folder, print the plan, change nothing
//          --force-version allow a version that is not higher (re-release / test only)
// The repository root is the parent of this file's folder, so the tool can be tested on a copy.
import { spawnSync } from "node:child_process";
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findDevBranding } from "./release-checks.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEV = join(REPO, "app", "dev");
const STABLE = join(REPO, "app", "stable");
const APP_DIR = join(REPO, "app");

// Files that exist only in the dev channel.
const DEV_ONLY_FILES = new Set(["icon-dev.svg"]);
const STABLE_BRAND = {
  title: "LiftIQ | Set tracker",
  themeColor: "#101510",
  backgroundColor: "#101510",
  manifestName: "LiftIQ Set Tracker",
  manifestShortName: "LiftIQ",
};

function fail(message) {
  console.error(`\nRELEASE ABORTED: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const options = { dryRun: false, forceVersion: false, version: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--force-version") options.forceVersion = true;
    else if (arg === "--version") options.version = argv[++i];
    else if (arg.startsWith("--version=")) options.version = arg.slice("--version=".length);
    else fail(`unknown argument ${arg}`);
  }
  if (!options.version || !/^\d+\.\d+\.\d+$/.test(options.version)) {
    fail("--version X.Y.Z is required (plain semantic version, no suffix; the stable app never carries -dev).");
  }
  return options;
}

function compareVersions(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

function run(command, args, { cwd = REPO, label } = {}) {
  console.log(`\n$ ${label ?? [command, ...args].join(" ")}`);
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.error) fail(`could not run ${command}: ${result.error.message}`);
  return result.status === 0;
}

function testFiles(dir) {
  return readdirSync(dir).filter((name) => name.endsWith(".test.js")).map((name) => join(dir, name));
}

function runNodeTests(files, label) {
  if (files.length === 0) fail(`no test files found for ${label}`);
  return run(process.execPath, ["--test", ...files], { cwd: APP_DIR, label: `node --test (${label}, ${files.length} files)` });
}

function git(args) {
  return spawnSync("git", args, { cwd: REPO, encoding: "utf8" });
}

function replaceOnce(text, pattern, replacement, what) {
  const matches = typeof pattern === "string" ? text.split(pattern).length - 1 : (text.match(new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`)) ?? []).length;
  if (matches !== 1) fail(`expected exactly one occurrence of ${what} in the dev app, found ${matches}. Update tools/release-app.mjs together with the dev file.`);
  return text.replace(pattern, replacement);
}

// ---- transforms: dev file text -> stable file text ---------------------------------------
function transformIndexHtml(text) {
  let out = text;
  const stripped = out.replace(/[ \t]*<!--dev:start-->[\s\S]*?<!--dev:end-->[ \t]*/g, "");
  if (stripped === out) fail("index.html has no <!--dev:start-->...<!--dev:end--> block to strip.");
  out = stripped;
  out = replaceOnce(out, /<title>[^<]*<\/title>/, `<title>${STABLE_BRAND.title}</title>`, "<title>");
  out = replaceOnce(out, /(<meta name="theme-color" content=")[^"]*(")/, `$1${STABLE_BRAND.themeColor}$2`, "theme-color meta");
  return out.replaceAll("icon-dev.svg", "icon.svg");
}

function transformManifest(text) {
  const manifest = JSON.parse(text);
  manifest.name = STABLE_BRAND.manifestName;
  manifest.short_name = STABLE_BRAND.manifestShortName;
  manifest.theme_color = STABLE_BRAND.themeColor;
  manifest.background_color = STABLE_BRAND.backgroundColor;
  for (const icon of manifest.icons ?? []) icon.src = icon.src.replace("icon-dev.svg", "icon.svg");
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

function transformServiceWorker(text, cacheVersion) {
  let out = replaceOnce(text, /const CACHE_PREFIX = "[^"]*";/, 'const CACHE_PREFIX = "liftiq-app-";', "CACHE_PREFIX");
  out = replaceOnce(out, /const CACHE_NAME = "[^"]*";/, `const CACHE_NAME = "liftiq-app-v${cacheVersion}";`, "CACHE_NAME");
  out = out.replaceAll("icon-dev.svg", "icon.svg");
  return out.replace(/^\/\/ Dev channel:.*\n\/\/ and activate\(\).*\n\/\/ tool rewrites.*\n/m, "// Stable channel: caches are \"liftiq-app-vN\"; activate() only deletes older caches with this prefix.\n// The release tool bumps N on every release (never edit by hand).\n");
}

function transformChannel(text, version) {
  let out = replaceOnce(text, /export const CHANNEL = "[^"]*";/, 'export const CHANNEL = "stable";', "CHANNEL");
  out = replaceOnce(out, /export const APP_VERSION = "[^"]*";/, `export const APP_VERSION = "${version}";`, "APP_VERSION");
  return out;
}

function currentCacheVersion() {
  const swPath = join(STABLE, "sw.js");
  const match = existsSync(swPath) && readFileSync(swPath, "utf8").match(/const CACHE_NAME = "liftiq-app-v(\d+)";/);
  if (!match) fail("could not read the current stable cache name (app/stable/sw.js CACHE_NAME = liftiq-app-vN).");
  return Number(match[1]);
}

function listFiles(dir, base = dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(full, base));
    else files.push(relative(base, full).split("\\").join("/"));
  }
  return files.sort();
}

function buildStable(version, cacheVersion, targetDir) {
  mkdirSync(targetDir, { recursive: true });
  for (const file of listFiles(DEV)) {
    if (DEV_ONLY_FILES.has(file)) continue;
    const from = join(DEV, file);
    const to = join(targetDir, file);
    mkdirSync(dirname(to), { recursive: true });
    if (file === "index.html") writeFileSync(to, transformIndexHtml(readFileSync(from, "utf8")));
    else if (file === "manifest.webmanifest") writeFileSync(to, transformManifest(readFileSync(from, "utf8")));
    else if (file === "sw.js") writeFileSync(to, transformServiceWorker(readFileSync(from, "utf8"), cacheVersion));
    else if (file === "channel.js") writeFileSync(to, transformChannel(readFileSync(from, "utf8"), version));
    else cpSync(from, to);
  }
  writeFileSync(join(targetDir, "VERSION"), `${version}\n`);
}

// Sanity checks on the built stable app: nothing dev-branded may remain.
function verifyBuild(dir, version) {
  const problems = [];
  const read = (name) => readFileSync(join(dir, name), "utf8");
  for (const file of listFiles(dir).filter((f) => /\.(html|js|webmanifest|svg|css)$/.test(f) && !f.startsWith("test/"))) {
    problems.push(...findDevBranding(file, read(file))); // patterns and the allow-list live in tools/release-checks.mjs
  }
  if (!/export const CHANNEL = "stable";/.test(read("channel.js"))) problems.push("channel.js is not CHANNEL stable");
  if (!read("channel.js").includes(`"${version}"`)) problems.push("channel.js version mismatch");
  if (JSON.parse(read("manifest.webmanifest")).name !== STABLE_BRAND.manifestName) problems.push("manifest name not stable");
  if (!/<title>LiftIQ \| Set tracker<\/title>/.test(read("index.html"))) problems.push("index.html title not stable");
  if (!/const CACHE_NAME = "liftiq-app-v\d+";/.test(read("sw.js"))) problems.push("sw.js cache name not liftiq-app-vN");
  for (const file of ["index.html", "sw.js", "manifest.webmanifest"]) {
    for (const ref of read(file).matchAll(/\.\/([A-Za-z0-9_.-]+\.(?:js|css|svg|webmanifest))/g)) {
      if (!existsSync(join(dir, ref[1]))) problems.push(`${file} references missing file ${ref[1]}`);
    }
  }
  return problems;
}

function summarizeDiff(newDir) {
  const oldFiles = new Set(existsSync(STABLE) ? listFiles(STABLE) : []);
  const newFiles = new Set(listFiles(newDir));
  const added = [...newFiles].filter((f) => !oldFiles.has(f));
  const removed = [...oldFiles].filter((f) => !newFiles.has(f));
  const norm = (file) => readFileSync(file).toString("latin1").replaceAll("\r\n", "\n"); // ignore CRLF/LF checkout differences
  const changed = [...newFiles].filter((f) => oldFiles.has(f) && norm(join(STABLE, f)) !== norm(join(newDir, f)));
  return { added, removed, changed };
}

const options = parseArgs(process.argv.slice(2));
const { version } = options;
console.log(`LiftIQ release: app/dev -> app/stable as ${version}${options.dryRun ? " (DRY RUN)" : ""}`);
console.log(`repository: ${REPO}`);

if (!existsSync(DEV) || !existsSync(STABLE)) fail("app/dev and app/stable must both exist.");

// version check
const stableVersion = readFileSync(join(STABLE, "VERSION"), "utf8").trim();
if (!options.forceVersion && compareVersions(version, stableVersion) <= 0) {
  fail(`version ${version} must be higher than the current stable version ${stableVersion}.`);
}

// 2. git state of app/stable (and of the repo) --------------------------------------------
const inside = git(["rev-parse", "--is-inside-work-tree"]);
if (inside.status !== 0 || inside.stdout.trim() !== "true") fail("not a git repository (the release tool needs git to check app/stable).");
const dirtyStable = git(["status", "--porcelain", "--", "app/stable"]);
if (dirtyStable.status !== 0) fail(`git status failed: ${dirtyStable.stderr}`);
if (dirtyStable.stdout.trim()) {
  fail(`app/stable has uncommitted changes. Stable changes happen only through this tool; commit or revert them first:\n${dirtyStable.stdout}`);
}
const dirtyDev = git(["status", "--porcelain", "--", "app/dev", "firmware", "tests"]);
if (dirtyDev.stdout.trim()) {
  console.warn("\nWARNING: app/dev, firmware/ or tests/ have uncommitted changes. The release is built from the working tree;\n" +
    "commit the dev work first if the stable snapshot should be reproducible from git history.");
}

// 1. tests ------------------------------------------------------------------------------------
if (!runNodeTests(testFiles(join(DEV, "test")), "app/dev unit tests")) fail("dev unit tests failed.");
const compatDir = join(REPO, "tests", "compat");
if (!runNodeTests(testFiles(compatDir), "tests/compat against the dev protocol decoder")) fail("compat tests failed.");

// 3 + 4. build in a temp dir and verify it -----------------------------------------------------
const cacheVersion = currentCacheVersion() + 1;
const staging = mkdtempSync(join(tmpdir(), "liftiq-release-"));
let keepStaging = false;
try {
  buildStable(version, cacheVersion, staging);
  const problems = verifyBuild(staging, version);
  if (problems.length) fail(`built stable app failed verification:\n  - ${problems.join("\n  - ")}`);
  const diff = summarizeDiff(staging);
  console.log(`\nStable ${stableVersion} -> ${version}, cache liftiq-app-v${cacheVersion - 1} -> liftiq-app-v${cacheVersion}`);
  console.log(`  added:   ${diff.added.join(", ") || "-"}`);
  console.log(`  removed: ${diff.removed.join(", ") || "-"}`);
  console.log(`  changed: ${diff.changed.join(", ") || "-"}`);

  if (options.dryRun) {
    console.log("\nDRY RUN: app/stable was not modified. Staged build (deleted on exit) passed verification.");
    process.exit(0);
  }

  // write into app/stable: remove files that no longer exist, copy the rest
  for (const file of diff.removed) rmSync(join(STABLE, file), { force: true });
  for (const file of listFiles(staging)) {
    const to = join(STABLE, file);
    mkdirSync(dirname(to), { recursive: true });
    cpSync(join(staging, file), to);
  }
  for (const entry of readdirSync(STABLE, { withFileTypes: true })) {
    if (entry.isDirectory() && readdirSync(join(STABLE, entry.name)).length === 0) rmSync(join(STABLE, entry.name), { recursive: true });
  }

  // 5. tests on the released copy
  if (!runNodeTests(testFiles(join(STABLE, "test")), "app/stable unit tests (new release)")) {
    keepStaging = true;
    fail("the new stable app fails its own tests. Revert with: git checkout -- app/stable && git clean -fd app/stable");
  }
} finally {
  if (!keepStaging) rmSync(staging, { recursive: true, force: true });
}

console.log(`
RELEASE ${version} BUILT in app/stable (nothing committed, nothing pushed).
Next steps:
  1. Review:   git status app/stable && git diff --stat -- app/stable
  2. Try it:   cd app && npm run start:stable   (http://localhost:8001, connect a sensor; Chrome DevTools > Application
               > Service Workers: confirm cache liftiq-app-v${cacheVersion})
  3. Commit:   git add app/stable && git commit -m "Release app ${version}"
  4. Publish:  git push   (the Pages workflow deploys app/stable only; first deploy after a release may take ~1 min)
Rollback before commit: git checkout -- app/stable && git clean -fd app/stable
`);
