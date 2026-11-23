// Seed exercise library (cable-stack machines) and inline-SVG pictograms.
// Own artwork, no external assets. `opengymId` is reserved for the later openGym mapping (W5).

export function slugify(text) {
  const slug = String(text ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "exercise";
}

export const SEED_EXERCISES = Object.freeze([
  { id: "seated-cable-row", name: "Seated cable row", machine: "Cable stack", muscles: ["Back", "Biceps"], cue: "Sit tall, pull the handle to your belly, squeeze the shoulder blades, return slowly.", pictogram: "row" },
  { id: "lat-pulldown", name: "Lat pulldown", machine: "Cable stack", muscles: ["Lats", "Biceps"], cue: "Pull the bar to the upper chest with elbows down, control the way up.", pictogram: "pulldown" },
  { id: "machine-chest-press", name: "Machine chest press", machine: "Stack machine", muscles: ["Chest", "Triceps"], cue: "Back flat on the pad, press forward without locking out, return slowly.", pictogram: "chest" },
  { id: "machine-shoulder-press", name: "Machine shoulder press", machine: "Stack machine", muscles: ["Shoulders", "Triceps"], cue: "Press straight up from shoulder height, keep the ribs down.", pictogram: "shoulder" },
  { id: "machine-leg-press", name: "Leg press", machine: "Stack machine", muscles: ["Quads", "Glutes"], cue: "Feet shoulder-width, push through the heels, do not lock the knees.", pictogram: "legpress" },
  { id: "leg-extension", name: "Leg extension", machine: "Stack machine", muscles: ["Quads"], cue: "Extend the knees until the legs are straight, lower under control.", pictogram: "legext" },
  { id: "leg-curl", name: "Leg curl", machine: "Stack machine", muscles: ["Hamstrings"], cue: "Curl the heels toward the glutes, hips stay on the pad.", pictogram: "legcurl" },
  { id: "triceps-pushdown", name: "Cable triceps pushdown", machine: "Cable stack", muscles: ["Triceps"], cue: "Elbows pinned to the sides, push down to full extension, return slowly.", pictogram: "pushdown" },
  { id: "cable-biceps-curl", name: "Cable biceps curl", machine: "Cable stack", muscles: ["Biceps"], cue: "Upper arms still, curl the handle to the shoulders, lower slowly.", pictogram: "curl" },
  { id: "cable-fly", name: "Pec deck (machine fly)", aliases: ["Cable fly", "Pec fly", "Chest fly"], machine: "Stack machine", muscles: ["Chest"], cue: "Elbows slightly bent, bring the pads together in front of the chest, return slowly.", pictogram: "fly" },
].map((e) => Object.freeze({ ...e, opengymId: null, image: null, custom: false })));

export function customExercise(name, note = "", uuid = () => globalThis.crypto.randomUUID()) {
  const clean = String(name ?? "").trim().slice(0, 60);
  if (!clean) throw new Error("Give the exercise a name.");
  return { id: `custom-${uuid()}`, name: clean, machine: "Custom", muscles: [], cue: String(note ?? "").trim().slice(0, 200), pictogram: "custom", opengymId: null, image: null, custom: true };
}

/**
 * Which picture a machine shows: the user's own photo (object URL) first, then the packaged default image
 * (see applyImageCredits / docs/IMAGE_CREDITS.md), else null (pictogram).
 */
export function resolveImage(exercise, photoUrl = null) {
  const base = { credit: "", license: "", licenseUrl: "", sourceUrl: "", label: "", generic: false };
  if (photoUrl) return { ...base, url: photoUrl, kind: "photo" };
  const img = exercise?.image;
  if (img?.url) return { ...base, ...img, kind: "pack" };
  return null;
}

export const IMAGE_BASE = "./assets/machines/";

/** Attach the default images from credits.json (keyed by exercise id; `file: null` = none) as `image` fields. */
export function applyImageCredits(exercises, credits) {
  return exercises.map((e) => {
    const c = credits?.[e.id];
    if (!c?.file) return e;
    return Object.freeze({
      ...e,
      image: {
        url: IMAGE_BASE + c.file, credit: c.author || "", license: c.license || "", licenseUrl: c.licenseUrl || "",
        sourceUrl: c.sourceUrl || "", label: c.generic ? (c.label || "Example photo") : "", generic: Boolean(c.generic),
      },
    });
  });
}

/** "Photo: <author>, <license> — Wikimedia Commons" */
export function creditLine(image) {
  return image?.credit ? `Photo: ${image.credit}, ${image.license} \u2014 Wikimedia Commons` : "";
}

/** One entry per image file (TASL: title, author, source, licence) with the machines it is used for. */
export function creditsEntries(credits, exercises = SEED_EXERCISES) {
  const byFile = new Map();
  for (const [id, c] of Object.entries(credits || {})) {
    if (!c?.file) continue;
    const entry = byFile.get(c.file) || { file: c.file, title: String(c.title || "").replace(/^File:/, "").replace(/\.jpg$/i, ""), author: c.author, license: c.license, licenseUrl: c.licenseUrl, sourceUrl: c.sourceUrl, changes: c.changes, usedFor: [] };
    entry.usedFor.push(exercises.find((x) => x.id === id)?.name || id);
    byFile.set(c.file, entry);
  }
  return [...byFile.values()];
}

export function searchExercises(list, query) {
  const q = String(query ?? "").trim().toLowerCase();
  if (!q) return list;
  return list.filter((e) => [e.name, ...(e.aliases || []), e.machine, ...(e.muscles || [])].join(" ").toLowerCase().includes(q));
}

export const QUICK_EXERCISE = Object.freeze({ id: "quick", name: "Quick set", machine: "", muscles: [], cue: "A set without an exercise.", pictogram: "custom", opengymId: null, custom: false });

// ---- pictograms (64x64, currentColor strokes; accent via the pi-accent class) ------------------
const stack = (x = 8) => `<g class="pi-stack"><rect x="${x}" y="10" width="10" height="5" rx="1"/><rect x="${x}" y="17" width="10" height="5" rx="1"/><rect x="${x}" y="24" width="10" height="5" class="pi-accent" rx="1"/><rect x="${x}" y="31" width="10" height="5" rx="1"/></g>`;
const arrow = (x1, y1, x2, y2) => `<path class="pi-arrow" d="M${x1} ${y1}L${x2} ${y2}"/><path class="pi-arrow" d="${arrowHead(x1, y1, x2, y2)}"/>`;
function arrowHead(x1, y1, x2, y2) {
  const a = Math.atan2(y2 - y1, x2 - x1);
  const p = (d) => `${(x2 - 5 * Math.cos(a + d)).toFixed(1)} ${(y2 - 5 * Math.sin(a + d)).toFixed(1)}`;
  return `M${p(0.5)}L${x2} ${y2}L${p(-0.5)}`;
}
const seat = (x, y, w = 14) => `<rect x="${x}" y="${y}" width="${w}" height="4" rx="1"/>`;
const person = (x, y) => `<circle cx="${x}" cy="${y}" r="3.2"/><path d="M${x} ${y + 4}v11"/>`;

const PICTOGRAMS = {
  row: () => `${stack()}<path d="M18 26H44"/><path d="M44 22v8"/>${seat(38, 46)}${person(46, 31)}${arrow(52, 26, 36, 26)}<path d="M8 52h48"/>`,
  pulldown: () => `${stack(40)}<path d="M40 8H22"/><path d="M14 10h16"/><path d="M22 10v8"/>${seat(20, 48)}${person(22, 28)}${arrow(14, 14, 14, 30)}`,
  chest: () => `${stack(44)}<path d="M44 30H30"/><path d="M26 24v12"/>${seat(8, 42, 20)}<path d="M8 38v4"/>${person(14, 30)}${arrow(22, 30, 34, 30)}`,
  shoulder: () => `${stack(44)}<path d="M44 14H30"/><path d="M26 10h8"/>${seat(12, 46, 16)}${person(20, 28)}${arrow(30, 28, 30, 12)}`,
  legpress: () => `${stack(46)}<path d="M46 30H34"/><path d="M34 22v16"/><path d="M8 50L30 34" /><circle cx="12" cy="44" r="3"/>${arrow(24, 40, 31, 35)}`,
  legext: () => `${stack(46)}<path d="M46 34H36"/>${seat(8, 34, 18)}<path d="M26 34h10"/><path d="M12 22v12"/><circle cx="12" cy="18" r="3.2"/>${arrow(32, 44, 40, 30)}`,
  legcurl: () => `${stack(46)}<path d="M46 34H36"/>${seat(8, 32, 22)}<circle cx="10" cy="26" r="3.2"/><path d="M30 34h6v12"/>${arrow(40, 30, 40, 46)}`,
  pushdown: () => `${stack(8)}<path d="M18 14H34"/><path d="M34 14V40"/><path d="M28 40h12"/>${person(24, 26)}${arrow(48, 22, 48, 42)}`,
  curl: () => `${stack(8)}<path d="M18 40H40"/><path d="M40 40V28"/>${person(30, 20)}<path d="M30 35l8 4"/>${arrow(48, 42, 48, 26)}`,
  fly: () => `${stack(8)}<path d="M18 16L30 28"/><path d="M52 16L40 28"/>${person(35, 30)}${arrow(14, 36, 28, 36)}${arrow(58, 36, 44, 36)}<path d="M52 8v8" /><path d="M18 8v0"/>`,
  custom: () => `<rect x="14" y="16" width="36" height="32" rx="4"/><path d="M22 32h20"/><path d="M32 22v20"/>`,
};

export function pictogramSvg(key, { size = 56, label = "" } = {}) {
  const body = (PICTOGRAMS[key] || PICTOGRAMS.custom)();
  const aria = label ? `role="img" aria-label="${label.replaceAll('"', "&quot;")}"` : 'aria-hidden="true"';
  return `<svg class="pictogram" viewBox="0 0 64 64" width="${size}" height="${size}" ${aria} fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
}
