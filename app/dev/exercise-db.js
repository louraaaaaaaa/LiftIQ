// Exercise library: the open dataset index (docs/EXERCISE_DATA.md), the 10 seed machines, custom machines,
// equipment classification (sensor support), filters, search and pagination. Pure functions, no DOM.
// Saved sets and workouts keep referencing the exercise ids/names exactly as before: seeds keep their
// ids, custom machines their own ids, dataset entries are "ds-<datasetId>".

export const INDEX_URL = "./assets/exercise-db/exercises.min.json";
export const META_URL = "./assets/exercise-db/meta.json";
export const PAGE_SIZE = 40;

// ---- sensor support ---------------------------------------------------------------------------
export const SUPPORT = Object.freeze({ SUPPORTED: "supported", EXPERIMENTAL: "experimental", UNSUPPORTED: "unsupported", UNKNOWN: "unknown" });
export const SUPPORT_BADGE = Object.freeze({
  supported: "Rep analysis: validated for cable stack",
  experimental: "Rep analysis: experimental",
  unsupported: "Rep analysis: not supported",
  unknown: "",
});
export const SUPPORT_WARNING = Object.freeze({
  supported: "",
  experimental: "Rep analysis is experimental for this kind of machine (the weight moves on an arc or on a sled). Check the count and edit it if needed.",
  unsupported: "Rep analysis is not validated for this equipment (free weights, body weight, bands or cardio). The count may be wrong: check it and edit it if needed.",
  unknown: "",
});

/** Documented in docs/EXERCISE_DATA.md. Every distinct `equipment` value of the dataset is listed. */
export const EQUIPMENT_CLASS = Object.freeze({
  cable: "supported",
  "leverage machine": "experimental",
  "sled machine": "experimental",
  "smith machine": "experimental",
  "body weight": "unsupported", assisted: "unsupported", "medicine ball": "unsupported", "stability ball": "unsupported",
  band: "unsupported", "resistance band": "unsupported", barbell: "unsupported", "olympic barbell": "unsupported",
  "ez barbell": "unsupported", "trap bar": "unsupported", dumbbell: "unsupported", kettlebell: "unsupported",
  rope: "unsupported", weighted: "unsupported", "bosu ball": "unsupported", roller: "unsupported", "wheel roller": "unsupported",
  hammer: "unsupported", tire: "unsupported", "upper body ergometer": "unsupported", "skierg machine": "unsupported",
  "stationary bike": "unsupported", "elliptical machine": "unsupported", "stepmill machine": "unsupported",
});

/** Equipment text (dataset value or a LiftIQ seed label such as "Cable stack") -> supported | experimental | unsupported | unknown. */
export function classifyEquipment(equipment) {
  const key = String(equipment ?? "").trim().toLowerCase();
  if (!key || key === "custom") return SUPPORT.UNKNOWN;
  if (Object.hasOwn(EQUIPMENT_CLASS, key)) return EQUIPMENT_CLASS[key];
  if (/\b(cable|stack|selectorized)\b/.test(key)) return SUPPORT.SUPPORTED;
  if (/\b(lever|leverage|smith|sled|plate)\b/.test(key)) return SUPPORT.EXPERIMENTAL;
  return SUPPORT.UNSUPPORTED;
}

// ---- seed -> dataset mapping (rationale in docs/EXERCISE_DATA.md) -----------------------------------
export const SEED_DATASET_MAP = Object.freeze({
  "seated-cable-row": { dsId: "0861", why: "Exact match: 'cable seated row' (cable, upper back)." },
  "lat-pulldown": { dsId: "2330", why: "The only cable entry named lat pulldown (seated, thigh pad, full range)." },
  "machine-chest-press": { dsId: "0576", why: "Seated 'lever chest press' is the closest selectorized chest press (0576 and 0577 are identical names; 0576 used)." },
  "machine-shoulder-press": { dsId: "0603", why: "'lever shoulder press' is the plain seated machine shoulder press (v. 2 and v. 3 are variants)." },
  "machine-leg-press": { dsId: "1463", why: "'sled 45 degree leg press (side pov)' is the standard leg press with a clear side view; the dataset has no selectorized leg press (lever versions are single-leg or alternating)." },
  "leg-extension": { dsId: "0585", why: "'lever leg extension' (the dataset's only leg extension machine)." },
  "leg-curl": { dsId: "0599", why: "'lever seated leg curl' matches the seated stack leg curl (lying and kneeling versions also exist)." },
  "triceps-pushdown": { dsId: "0241", why: "'cable triceps pushdown (v-bar)' is the standard high-pulley pushdown (0201 'cable pushdown' is the generic name)." },
  "cable-biceps-curl": { dsId: "0868", why: "'cable curl' (cable, biceps) is the plain low-pulley curl." },
  "cable-fly": { dsId: "0596", why: "'lever seated fly' is the pec deck." },
});

// ---- dataset records -> exercises ---------------------------------------------------------------
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const PICTO = [[/pulldown|pull-down|pull down/, "pulldown"], [/\brow\b/, "row"], [/chest press|bench press/, "chest"], [/shoulder press|overhead press/, "shoulder"],
  [/leg press/, "legpress"], [/leg extension/, "legext"], [/leg curl/, "legcurl"], [/pushdown/, "pushdown"], [/curl/, "curl"], [/\bfly\b|pec deck/, "fly"]];
export function pictogramFor(name) {
  const n = String(name).toLowerCase();
  for (const [re, key] of PICTO) if (re.test(n)) return key;
  return "custom";
}

/** Compact record (build-index.mjs short keys) -> the details object kept under `ds`. */
export function expandRecord(r) {
  return {
    id: r.i, name: r.n, category: r.c, bodyPart: r.b, equipment: r.e, target: r.t, muscleGroup: r.g,
    secondary: r.s || [], steps: r.st || [], media: r.m,
    imageFile: r.im || `${r.i}-${r.m}.jpg`, gifFile: r.gf || `${r.i}-${r.m}.gif`,
  };
}

export function datasetExercise(record) {
  const ds = expandRecord(record);
  const muscles = [ds.target, ...ds.secondary].filter(Boolean).map(cap);
  return {
    id: `ds-${ds.id}`, name: cap(ds.name), machine: cap(ds.equipment), muscles, cue: "", pictogram: pictogramFor(ds.name),
    opengymId: null, image: null, custom: false, kind: "dataset", support: classifyEquipment(ds.equipment), ds,
  };
}

/** The fields persisted with a workout (small, stable). Never the dataset details. */
export function leanExercise(e) {
  const { id, name, machine, muscles, cue, pictogram, opengymId, image, custom } = e;
  const out = { id, name, machine, muscles: [...(muscles || [])], cue: cue || "", pictogram, opengymId: opengymId ?? null, image: image ?? null, custom: Boolean(custom) };
  if (e.aliases) out.aliases = e.aliases;
  return out;
}

/**
 * The full library: custom machines first, then the seeds (with their mapped dataset details), then the
 * dataset. Dataset entries that a seed maps to are not listed twice.
 */
export function buildLibrary({ seeds = [], custom = [], records = [] } = {}) {
  const byDs = new Map(records.map((r) => [r.i, r]));
  const mapped = new Set();
  const seedList = seeds.map((s) => {
    const m = SEED_DATASET_MAP[s.id];
    const rec = m && byDs.get(m.dsId);
    if (rec) mapped.add(m.dsId);
    return { ...s, kind: "seed", support: classifyEquipment(s.machine), ds: rec ? expandRecord(rec) : null };
  });
  const customList = custom.map((c) => ({ ...c, kind: "custom", support: SUPPORT.UNKNOWN, ds: null }));
  const dataset = records.filter((r) => !mapped.has(r.i)).map(datasetExercise).sort((a, b) => a.name.localeCompare(b.name));
  return [...customList, ...seedList, ...dataset];
}

export function facets(library) {
  const uniq = (get) => [...new Set(library.map(get).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  return { bodyParts: uniq((e) => e.ds?.bodyPart), targets: uniq((e) => e.ds?.target), equipment: uniq((e) => e.ds?.equipment) };
}

// ---- filter / search / pagination ----------------------------------------------------------------
const haystack = (e) => [e.name, ...(e.aliases || []), e.machine, ...(e.muscles || []), e.ds?.bodyPart, e.ds?.target, e.ds?.equipment, ...(e.ds?.secondary || [])].filter(Boolean).join(" ").toLowerCase();

/**
 * chip: "stack" (default; supported equipment, plus the user's own machines) or "all".
 * lastBy: { [exerciseId]: { startedAt } } puts recently used entries first (newest first).
 */
export function filterExercises(library, { chip = "stack", bodyPart = "", target = "", equipment = "", query = "", lastBy = {} } = {}) {
  const words = String(query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const out = library.filter((e) => {
    if (chip === "stack" && !(e.support === SUPPORT.SUPPORTED || e.kind === "custom")) return false;
    if (bodyPart && e.ds?.bodyPart !== bodyPart) return false;
    if (target && e.ds?.target !== target) return false;
    if (equipment && e.ds?.equipment !== equipment) return false;
    if (words.length) { const h = haystack(e); if (!words.every((w) => h.includes(w))) return false; }
    return true;
  });
  const used = (e) => lastBy[e.id]?.startedAt;
  return out.map((e, i) => [e, i]).sort(([a, i], [b, j]) => {
    const ua = used(a), ub = used(b);
    if (ua && ub) return String(ub).localeCompare(String(ua)) || i - j;
    if (ua) return -1;
    if (ub) return 1;
    return i - j;
  }).map(([e]) => e);
}

export function paginate(list, page = 0, size = PAGE_SIZE) {
  const end = Math.min(list.length, (page + 1) * size);
  return { items: list.slice(page * size, end), total: list.length, hasMore: end < list.length, nextPage: page + 1 };
}

// ---- loading --------------------------------------------------------------------------------------
/** Fetch the generated index. Throws on any problem; the app then continues with the seeds only. */
export async function loadExerciseIndex(fetchFn = globalThis.fetch) {
  const [metaRes, listRes] = await Promise.all([fetchFn(META_URL), fetchFn(INDEX_URL)]);
  if (!metaRes.ok || !listRes.ok) throw new Error("exercise index not available");
  const meta = await metaRes.json();
  const records = await listRes.json();
  if (!Array.isArray(records) || !/^[0-9a-f]{40}$/.test(String(meta?.sha))) throw new Error("exercise index is malformed");
  return { meta, records };
}
