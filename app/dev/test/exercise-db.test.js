import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildIndex, compactRecords, cleanName } from "../../../tools/exercise-db/build-index.mjs";
import {
  EXERCISE_MEDIA_ENABLED_DEFAULT, EXERCISE_MEDIA_KEY, ATTRIBUTION_TEXT, MEDIA_HOSTS, mediaUrls, datasetMediaHtml, nextMediaStep, isMediaEnabled, setMediaEnabled,
} from "../exercise-media.js";
import {
  EQUIPMENT_CLASS, SEED_DATASET_MAP, classifyEquipment, buildLibrary, filterExercises, paginate, facets, leanExercise, datasetExercise, expandRecord, pictogramFor, PAGE_SIZE,
} from "../exercise-db.js";
import { SEED_EXERCISES, customExercise } from "../exercises.js";
import { WorkoutMachine } from "../workout.js";
import { MemoryWorkoutStorage } from "../workout-storage.js";
import { setLabel } from "../set-format.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");
const fixtureDir = path.join(root, "tests/fixtures/exercise-db");
const sample = JSON.parse(fs.readFileSync(path.join(fixtureDir, "exercises.sample.json"), "utf8"));
const dbDir = path.join(root, "app/dev/assets/exercise-db");
const index = JSON.parse(fs.readFileSync(path.join(dbDir, "exercises.min.json"), "utf8"));
const meta = JSON.parse(fs.readFileSync(path.join(dbDir, "meta.json"), "utf8"));
const SHA = "7455efae41b330c265e7cd4b78dfa848e7ce5ebd";

// ---- index builder -----------------------------------------------------------------------------------
test("builder: compact English-only records from real-shaped fixtures, names cleaned, derived file names omitted", () => {
  const { items, meta: m } = buildIndex(sample, SHA, { now: () => "2026-11-22T00:00:00.000Z" });
  assert.equal(items.length, sample.length);
  assert.deepEqual(m, { sha: SHA, count: sample.length, generatedAt: "2026-11-22T00:00:00.000Z", sourceUrl: "https://github.com/hasaneyldrm/exercises-dataset", dataLicense: "MIT", mediaNotice: "© Gym visual — https://gymvisual.com/" });
  const row = items.find((x) => x.i === "0861");
  assert.deepEqual([row.n, row.e, row.t, row.b], ["cable seated row", "cable", "upper back", "back"]);
  assert.ok(row.st.length >= 3 && row.st.every((s) => typeof s === "string"));
  assert.equal(row.im, undefined, "image name derived from id + media id");
  assert.equal(row.gf, undefined);
  assert.equal(JSON.stringify(items).includes("instruction_steps"), false);
  assert.ok(!JSON.stringify(items).includes("Sdraiati"), "no non-English text");
  assert.equal(items.find((x) => x.i === "0738").n.includes("°"), true, "mojibake degree sign fixed");
  assert.equal(cleanName("sled 45в° leg press"), "sled 45° leg press");
});

test("builder: pins a commit, rejects bad input and writes the files (CLI)", () => {
  assert.throws(() => buildIndex(sample, "main"), /commit/);
  assert.throws(() => compactRecords([{ id: "1", name: "a" }, { id: "1", name: "b" }]), /duplicate/);
  assert.throws(() => compactRecords({}), /array/);
  const odd = compactRecords([{ id: "9", name: "x", image: "images/other.jpg", gif_url: "videos/other.gif", media_id: "m" }])[0];
  assert.deepEqual([odd.im, odd.gf], ["other.jpg", "other.gif"], "non-derivable names are kept");
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "liftiq-exdb-"));
  try {
    execFileSync(process.execPath, [path.join(root, "tools/exercise-db/build-index.mjs"), path.join(fixtureDir, "exercises.sample.json"), SHA, out, "--license", path.join(fixtureDir, "LICENSE-exercises-dataset.txt")], { stdio: "pipe" });
    assert.deepEqual(fs.readdirSync(out).sort(), ["LICENSE-exercises-dataset.txt", "exercises.min.json", "meta.json"]);
    assert.match(fs.readFileSync(path.join(out, "LICENSE-exercises-dataset.txt"), "utf8"), /MIT License[\s\S]*Copyright \(c\) 2026 Hasan Emir/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(out, "meta.json"), "utf8")).count, sample.length);
  } finally { fs.rmSync(out, { recursive: true, force: true }); }
});

test("generated index: pinned, complete, small, licence file present", () => {
  assert.equal(meta.count, 1324);
  assert.equal(index.length, 1324);
  assert.match(meta.sha, /^[0-9a-f]{40}$/);
  assert.equal(meta.dataLicense, "MIT");
  assert.match(meta.mediaNotice, /Gym visual/);
  assert.ok(fs.statSync(path.join(dbDir, "exercises.min.json")).size < 1.5 * 1024 * 1024);
  assert.match(fs.readFileSync(path.join(dbDir, "LICENSE-exercises-dataset.txt"), "utf8"), /MIT License/);
  assert.equal(new Set(index.map((x) => x.i)).size, 1324);
  assert.ok(index.every((x) => x.st.length > 0 && x.m), "every record has English steps and a media id");
});

// ---- runtime media URLs --------------------------------------------------------------------------------
test("media URLs: jsDelivr first, raw.githubusercontent fallback, pinned to the commit", () => {
  assert.deepEqual(mediaUrls(SHA, "image", "0861-fUBheHs.jpg"), [
    `https://cdn.jsdelivr.net/gh/hasaneyldrm/exercises-dataset@${SHA}/images/0861-fUBheHs.jpg`,
    `https://raw.githubusercontent.com/hasaneyldrm/exercises-dataset/${SHA}/images/0861-fUBheHs.jpg`,
  ]);
  assert.deepEqual(mediaUrls(SHA, "gif", "0861-fUBheHs.gif").map((u) => u.includes("/videos/0861-fUBheHs.gif")), [true, true]);
  assert.deepEqual(new Set(mediaUrls(SHA, "image", "a.jpg").map((u) => new URL(u).hostname)), new Set(MEDIA_HOSTS));
  assert.deepEqual(mediaUrls("main", "image", "a.jpg"), [], "unpinned references are refused");
  assert.deepEqual(mediaUrls(SHA, "image", "../x.jpg"), [], "odd file names are refused");
  assert.deepEqual(mediaUrls(SHA, "other", "a.jpg"), []);
});

test("switch OFF: no media URLs and no markup (so no network request can happen)", () => {
  assert.equal(EXERCISE_MEDIA_ENABLED_DEFAULT, true);
  assert.deepEqual(mediaUrls(SHA, "image", "a.jpg", { enabled: false }), []);
  assert.equal(datasetMediaHtml({ sha: SHA, kind: "image", file: "a.jpg", enabled: false }), "");
  assert.equal(datasetMediaHtml({ sha: SHA, kind: "gif", file: "a.gif", enabled: false }), "");
  const store = new Map();
  const fake = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, v) };
  assert.equal(isMediaEnabled(fake), true, "default");
  setMediaEnabled(false, fake);
  assert.equal(store.get(EXERCISE_MEDIA_KEY), "0");
  assert.equal(isMediaEnabled(fake), false);
  setMediaEnabled(true, fake);
  assert.equal(isMediaEnabled(fake), true);
  assert.equal(isMediaEnabled({ getItem() { throw new Error("blocked"); } }), EXERCISE_MEDIA_ENABLED_DEFAULT, "unavailable storage falls back to the default");
});

test("shared renderer: attribution caption with the link is ALWAYS rendered with every dataset image or GIF", () => {
  for (const kind of ["image", "gif"]) for (const size of ["thumb", "full"]) {
    const html = datasetMediaHtml({ sha: SHA, kind, file: kind === "gif" ? "0861-x.gif" : "0861-x.jpg", alt: "Row", size });
    assert.ok(html.includes(ATTRIBUTION_TEXT), `${kind}/${size} caption text`);
    assert.ok(html.includes('href="https://gymvisual.com/"'), "caption links to gymvisual.com");
    assert.ok(/<figcaption[^>]*>.*<\/figcaption>/.test(html));
    assert.ok(html.includes('loading="lazy"') && html.includes('decoding="async"') && html.includes('referrerpolicy="no-referrer"'));
    assert.ok(html.includes("data-fallback=") && html.includes("raw.githubusercontent.com"));
    assert.ok(/width="(72|180)" height="(72|180)"/.test(html), "never larger than 180 px");
  }
  assert.ok(datasetMediaHtml({ sha: SHA, kind: "image", file: "a.jpg", alt: '"><script>' }).includes("&quot;&gt;&lt;script&gt;"), "alt text is escaped");
});

test("failure order: fallback URL once, then the placeholder", () => {
  const img = { dataset: { fallback: "https://raw.githubusercontent.com/x" } };
  assert.deepEqual(nextMediaStep(img), { action: "fallback", src: "https://raw.githubusercontent.com/x" });
  img.dataset.tried = "1";
  assert.deepEqual(nextMediaStep(img), { action: "placeholder" });
  assert.deepEqual(nextMediaStep({ dataset: {} }), { action: "placeholder" });
});

// ---- equipment classification ------------------------------------------------------------------------------
test("classification: every distinct dataset equipment value is in the documented table", () => {
  const values = [...new Set(index.map((x) => x.e))];
  assert.equal(values.length, 28);
  for (const v of values) assert.ok(Object.hasOwn(EQUIPMENT_CLASS, v), `${v} classified explicitly`);
  assert.equal(Object.keys(EQUIPMENT_CLASS).length, values.length, "no stale rows");
  assert.equal(classifyEquipment("cable"), "supported");
  for (const v of ["leverage machine", "sled machine", "smith machine"]) assert.equal(classifyEquipment(v), "experimental");
  for (const v of ["body weight", "barbell", "dumbbell", "band", "kettlebell", "stationary bike", "hammer", "assisted"]) assert.equal(classifyEquipment(v), "unsupported");
  // LiftIQ's own labels
  assert.equal(classifyEquipment("Cable stack"), "supported");
  assert.equal(classifyEquipment("Stack machine"), "supported");
  assert.equal(classifyEquipment("Custom"), "unknown");
  assert.equal(classifyEquipment(""), "unknown");
  assert.equal(classifyEquipment("Hammer Strength plate loaded"), "experimental");
  assert.equal(classifyEquipment("something else"), "unsupported");
});

// ---- library, filter, search, pagination ----------------------------------------------------------------------
const custom = [customExercise("My row machine", "", () => "u1")];
const library = buildLibrary({ seeds: SEED_EXERCISES, custom, records: index });

test("library: all dataset exercises + seeds + custom, mapped dataset entries are not listed twice, ids are stable", () => {
  assert.equal(library.length, 1324 - 10 + 10 + 1);
  assert.equal(new Set(library.map((e) => e.id)).size, library.length);
  assert.deepEqual(library.slice(0, 11).map((e) => e.id), ["custom-u1", ...SEED_EXERCISES.map((s) => s.id)]);
  assert.ok(library.some((e) => e.id === "ds-0001"));
  assert.ok(!library.some((e) => e.id === "ds-0861"), "mapped to the seed");
  const seed = library.find((e) => e.id === "seated-cable-row");
  assert.equal(seed.ds.id, "0861");
  assert.equal(seed.name, "Seated cable row", "seed name untouched");
  assert.equal(seed.pictogram, "row");
  assert.equal(seed.support, "supported");
  const ds = library.find((e) => e.id === "ds-0001");
  assert.deepEqual([ds.name, ds.machine, ds.support, ds.ds.target], ["3/4 sit-up", "Body weight", "unsupported", "abs"]);
  assert.equal(ds.ds.imageFile, "0001-2gPfomN.jpg");
  assert.equal(ds.ds.gifFile, "0001-2gPfomN.gif");
  assert.equal(pictogramFor("cable seated row"), "row");
  assert.equal(pictogramFor("lat pulldown"), "pulldown");
  assert.equal(pictogramFor("barbell squat"), "custom");
  const lean = leanExercise(ds);
  assert.equal(lean.ds, undefined);
  assert.equal(lean.support, undefined);
  assert.ok(JSON.stringify(lean).length < 400, "what is persisted with a workout stays small");
});

test("filter: default 'stack' chip shows supported equipment + custom machines; 'all' shows everything", () => {
  const stack = filterExercises(library);
  assert.ok(stack.every((e) => e.support === "supported" || e.kind === "custom"));
  assert.ok(stack.length > 100 && stack.length < 250, `${stack.length} stack entries`);
  assert.equal(filterExercises(library, { chip: "all" }).length, library.length);
  const lats = filterExercises(library, { chip: "all", target: "lats", equipment: "cable" });
  assert.ok(lats.length > 5 && lats.every((e) => e.ds.target === "lats" && e.ds.equipment === "cable"));
  assert.ok(filterExercises(library, { chip: "all", bodyPart: "chest" }).every((e) => e.ds.bodyPart === "chest"));
});

test("search: by name, muscle and equipment, all words must match, case-insensitive", () => {
  const a = filterExercises(library, { chip: "all", query: "pulldown" });
  assert.ok(a.length > 10 && a.every((e) => /pulldown/i.test(e.name)));
  const b = filterExercises(library, { chip: "all", query: "lats cable" });
  assert.ok(b.length > 5 && b.every((e) => e.ds?.target === "lats" || e.muscles.join(" ").toLowerCase().includes("lats")));
  assert.ok(filterExercises(library, { chip: "all", query: "PEC FLY" }).length > 0);
  assert.equal(filterExercises(library, { chip: "all", query: "zzzzqq" }).length, 0);
  assert.ok(filterExercises(library, { chip: "all", query: "cable fly" }).some((e) => e.id === "cable-fly"), "seed alias still searchable");
  assert.ok(filterExercises(library, { query: "my row" }).some((e) => e.id === "custom-u1"));
});

test("recent first, then library order", () => {
  const lastBy = { "ds-0001": { startedAt: "2026-11-20T10:00:00Z" }, "leg-curl": { startedAt: "2026-11-21T10:00:00Z" } };
  const out = filterExercises(library, { chip: "all", lastBy });
  assert.deepEqual(out.slice(0, 2).map((e) => e.id), ["leg-curl", "ds-0001"]);
  assert.equal(out.length, library.length);
  assert.equal(out[2].id, "custom-u1");
});

test("pagination: pages of 40, stable, no overlap, last page flagged", () => {
  const list = filterExercises(library, { chip: "all" });
  assert.equal(PAGE_SIZE, 40);
  const p0 = paginate(list, 0);
  assert.equal(p0.items.length, 40);
  assert.equal(p0.hasMore, true);
  assert.equal(p0.total, list.length);
  const p1 = paginate(list, p0.nextPage);
  assert.equal(p1.items[0].id, list[40].id);
  const lastPage = Math.ceil(list.length / 40) - 1;
  const last = paginate(list, lastPage);
  assert.equal(last.hasMore, false);
  assert.equal(last.items.at(-1).id, list.at(-1).id);
  assert.deepEqual(paginate([], 0), { items: [], total: 0, hasMore: false, nextPage: 1 });
  const f = facets(library);
  assert.ok(f.bodyParts.includes("upper arms") && f.targets.includes("lats") && f.equipment.includes("cable"));
});

// ---- seed mapping ------------------------------------------------------------------------------------------------
test("seed mapping: every seed maps to an existing dataset exercise with a rationale", () => {
  assert.deepEqual(Object.keys(SEED_DATASET_MAP).sort(), SEED_EXERCISES.map((e) => e.id).sort());
  const byId = new Map(index.map((r) => [r.i, r]));
  const dsIds = Object.values(SEED_DATASET_MAP).map((m) => m.dsId);
  assert.equal(new Set(dsIds).size, 10, "no two seeds share a dataset exercise");
  for (const [seedId, m] of Object.entries(SEED_DATASET_MAP)) {
    const rec = byId.get(m.dsId);
    assert.ok(rec, `${seedId} -> ${m.dsId} exists in the generated index`);
    assert.ok(m.why.length > 10);
    assert.ok(rec.st.length > 0 && rec.m, "has instructions and media");
  }
  const names = Object.fromEntries(Object.entries(SEED_DATASET_MAP).map(([k, m]) => [k, byId.get(m.dsId).n]));
  assert.equal(names["seated-cable-row"], "cable seated row");
  assert.equal(names["leg-extension"], "lever leg extension");
  assert.equal(names["cable-fly"], "lever seated fly");
});

// ---- old saved data keeps working --------------------------------------------------------------------------------
test("old saved sets and exercise shapes still resolve; selecting a seed keeps its id and name", async () => {
  const storage = new MemoryWorkoutStorage();
  const oldSet = { id: "s1", workoutId: "w1", blockId: "b1", exerciseId: "seated-cable-row", exerciseName: "Seated cable row", setNumber: 2, weightKg: 45, repsConfirmed: 8, startedAt: "2026-11-20T10:00:00.000Z", metrics: {} };
  const oldCustom = { id: "s2", workoutId: "w1", blockId: "b2", exerciseId: "custom-u1", exerciseName: "My row machine", setNumber: 1, weightKg: null, repsConfirmed: 5, startedAt: "2026-11-20T10:30:00.000Z", metrics: {} };
  await storage.saveSet(oldSet, null);
  await storage.saveSet(oldCustom, null);
  assert.match(setLabel(oldSet), /Seated cable row/);
  for (const s of [oldSet, oldCustom]) assert.ok(library.some((e) => e.id === s.exerciseId), `${s.exerciseId} still in the library`);
  let n = 0;
  const wm = new WorkoutMachine({ session: { subscribe() {}, snapshot: () => ({ state: "idle", connected: true }) }, storage, uuid: () => `id${++n}`, sensorName: () => "S" });
  const seed = library.find((e) => e.id === "seated-cable-row");
  await wm.selectExercise(leanExercise(seed));
  assert.equal(wm.exercise.id, "seated-cable-row");
  assert.equal(wm.exercise.name, "Seated cable row");
  assert.equal(wm.snapshot().weightKg, 45, "weight prefilled from the old set");
  assert.equal(wm.snapshot().lastSet.id, "s1");
  assert.equal(wm.block.exerciseId, "seated-cable-row");
  // a dataset exercise is stored lean, under its ds- id
  const wm2 = new WorkoutMachine({ session: { subscribe() {}, snapshot: () => ({ state: "idle", connected: true }) }, storage: new MemoryWorkoutStorage(), uuid: () => `x${++n}`, sensorName: () => "S" });
  await wm2.selectExercise(leanExercise(datasetExercise(index.find((r) => r.i === "0001"))));
  assert.equal(wm2.exercise.id, "ds-0001");
  assert.equal(wm2.exercise.name, "3/4 sit-up");
  assert.equal(expandRecord(index[0]).id, index[0].i);
});

// ---- service worker --------------------------------------------------------------------------------------------------
test("service worker: media runtime cache only for the dataset hosts, app shell list unchanged in style, big index not precached", () => {
  const sw = fs.readFileSync(path.join(here, "../sw.js"), "utf8");
  assert.ok(sw.includes("MEDIA_CACHE") && sw.includes("MEDIA_MAX_ENTRIES = 200"));
  for (const host of MEDIA_HOSTS) assert.ok(sw.includes(host));
  assert.ok(!sw.includes("exercises.min.json"), "the 850 kB index is cached lazily, not in the app shell");
  assert.ok(sw.includes("./exercise-db.js") && sw.includes("./exercise-media.js"));
  assert.ok(/name !== MEDIA_CACHE/.test(sw), "activate keeps the media cache");
  const re = /const MEDIA_PATH = (\/.*\/);/.exec(sw);
  const pattern = new RegExp(re[1].slice(1, -1));
  assert.ok(pattern.test(`https://cdn.jsdelivr.net/gh/hasaneyldrm/exercises-dataset@${SHA}/images/a.jpg`));
  assert.ok(pattern.test(`https://raw.githubusercontent.com/hasaneyldrm/exercises-dataset/${SHA}/videos/a.gif`));
  assert.ok(!pattern.test("https://cdn.jsdelivr.net/gh/other/repo@abc/images/a.jpg"));
});

test("no dataset media is stored in the repository", () => {
  const stack = [path.join(root, "app/dev/assets"), path.join(root, "tests/fixtures")];
  const found = [];
  while (stack.length) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (/\.gif$/i.test(entry.name) || (/exercise-db/.test(full) && /\.(jpe?g|png|webp)$/i.test(entry.name))) found.push(full);
    }
  }
  assert.deepEqual(found, []);
});

test("service worker behaviour (simulated): media is cached stale-while-revalidate, capped at 200, offline falls back to cache or an error, app files untouched", async () => {
  const vm = await import("node:vm");
  const code = fs.readFileSync(path.join(here, "../sw.js"), "utf8");
  const stores = new Map();
  const mkCache = (name) => {
    const m = stores.get(name) ?? new Map();
    stores.set(name, m);
    return { match: async (r) => m.get(r.url ?? r), put: async (r, res) => { m.set(r.url ?? r, res); }, keys: async () => [...m.keys()].map((url) => ({ url })), delete: async (r) => m.delete(r.url ?? r), addAll: async () => {} };
  };
  const listeners = {};
  let online = true;
  const fetched = [];
  const FakeResponse = class { constructor(type = "cors", ok = true) { this.type = type; this.ok = ok; } clone() { return this; } static error() { const r = new FakeResponse("error", false); r.isError = true; return r; } };
  const ctx = {
    self: { addEventListener: (t, fn) => { listeners[t] = fn; }, location: { origin: "http://localhost:8000" }, skipWaiting() {}, clients: { claim() {} } },
    caches: { open: async (n) => mkCache(n), keys: async () => [...stores.keys()], delete: async (n) => stores.delete(n), match: async () => undefined },
    fetch: async (req) => { fetched.push(req.url); if (!online) throw new Error("offline"); return new FakeResponse(req.url.includes("opaque") ? "opaque" : "cors", !req.url.includes("opaque")); },
    Response: FakeResponse, URL, Promise,
  };
  vm.runInNewContext(code, ctx);
  const run = async (url) => {
    let p; const waits = [];
    listeners.fetch({ request: { method: "GET", url }, respondWith: (x) => { p = x; }, waitUntil: (x) => waits.push(x) });
    const res = p ? await p : undefined;
    await Promise.all(waits);
    return res;
  };
  const media = (n) => `https://cdn.jsdelivr.net/gh/hasaneyldrm/exercises-dataset@${SHA}/images/${n}.jpg`;
  assert.equal((await run(media("a"))).ok, true);
  assert.equal(stores.get("liftiq-dev-media-v1").size, 1, "cached in its own cache");
  online = false;
  assert.equal((await run(media("a"))).ok, true, "offline: served from cache");
  assert.equal((await run(media("never-seen"))).isError, true, "offline and uncached: network error, handled by the page fallback");
  online = true;
  assert.equal((await run(media("opaque-1"))).type, "opaque");
  assert.equal(stores.get("liftiq-dev-media-v1").size, 2, "opaque responses are cached");
  for (let i = 0; i < 230; i++) await run(media(`f${i}`));
  assert.equal(stores.get("liftiq-dev-media-v1").size, 200, "capped");
  fetched.length = 0;
  assert.equal(await run("https://example.com/x.jpg"), undefined, "other hosts are not intercepted");
  assert.equal(await run(`https://cdn.jsdelivr.net/gh/other/repo@${SHA}/images/a.jpg`), undefined, "other repos are not intercepted");
  assert.equal(fetched.length, 0);
});
