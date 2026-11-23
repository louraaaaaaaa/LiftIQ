// Runtime links to the open exercise dataset's media (https://github.com/hasaneyldrm/exercises-dataset).
// The images and GIFs are (c) Gym visual: they are NEVER stored in this repository, only linked at runtime
// from a pinned commit, always with the attribution below. See docs/EXERCISE_DATA.md for the licence status.
// If the owner of the media objects: set EXERCISE_MEDIA_ENABLED_DEFAULT to false (or delete this module's
// callers); nothing else in the app depends on the media.

/** ONE place to flip the default of the Settings switch "Online exercise previews". */
export const EXERCISE_MEDIA_ENABLED_DEFAULT = false;
export const EXERCISE_MEDIA_KEY = "liftiq-exercise-media";

export const DATASET_REPO = "hasaneyldrm/exercises-dataset";
export const ATTRIBUTION_TEXT = "\u00A9 Gym visual \u2014 https://gymvisual.com/";
export const ATTRIBUTION_URL = "https://gymvisual.com/";
export const MEDIA_MAX_PX = 180;
export const MEDIA_HOSTS = Object.freeze(["cdn.jsdelivr.net", "raw.githubusercontent.com"]);

const SHA = /^[0-9a-f]{40}$/;
const FILE = /^[A-Za-z0-9._-]+$/;

export function isMediaEnabled(store = globalThis.localStorage) {
  try {
    const v = store?.getItem(EXERCISE_MEDIA_KEY);
    return v === null || v === undefined ? EXERCISE_MEDIA_ENABLED_DEFAULT : v === "1";
  } catch { return EXERCISE_MEDIA_ENABLED_DEFAULT; }
}

export function setMediaEnabled(enabled, store = globalThis.localStorage) {
  try { store?.setItem(EXERCISE_MEDIA_KEY, enabled ? "1" : "0"); } catch { /* ignore */ }
  return Boolean(enabled);
}

/**
 * Candidate URLs, in the order they are tried: jsDelivr first, raw.githubusercontent.com as the fallback.
 * `kind` is "image" (images/<file>.jpg) or "gif" (videos/<file>.gif). Returns [] when the media is off or the
 * input is not a safe pinned reference (no commit hash or a file name with odd characters).
 */
export function mediaUrls(sha, kind, file, { enabled = true } = {}) {
  if (!enabled || !SHA.test(String(sha)) || !FILE.test(String(file ?? ""))) return [];
  const dir = kind === "gif" ? "videos" : kind === "image" ? "images" : null;
  if (!dir) return [];
  return [
    `https://cdn.jsdelivr.net/gh/${DATASET_REPO}@${sha}/${dir}/${file}`,
    `https://raw.githubusercontent.com/${DATASET_REPO}/${sha}/${dir}/${file}`,
  ];
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

/**
 * THE shared renderer for every dataset image or GIF in the app. It always emits the attribution caption
 * together with the picture, so a call site cannot forget it. Returns "" when the media is off or the
 * reference is invalid (the caller then shows its pictogram). The failure handling is attached by
 * `wireDatasetMedia` (img error events do not bubble, so one capture listener per container is enough).
 *   size: "thumb" (picker card) or "full" (setup screen, never above 180 CSS px)
 */
export function datasetMediaHtml({ sha, kind = "image", file, alt = "", enabled = true, size = "full", placeholder = "" }) {
  const [primary, fallback] = mediaUrls(sha, kind, file, { enabled });
  if (!primary) return "";
  const px = size === "thumb" ? 72 : MEDIA_MAX_PX;
  return `<figure class="ds-media ds-${size}" data-kind="${kind}">`
    + `<span class="ds-frame"><img src="${esc(primary)}" data-fallback="${esc(fallback)}" alt="${esc(alt)}" width="${px}" height="${px}" loading="lazy" decoding="async" referrerpolicy="no-referrer" crossorigin="anonymous">`
    + `<span class="ds-placeholder" hidden>${placeholder}</span></span>`
    + `<figcaption class="ds-caption"><a href="${ATTRIBUTION_URL}" target="_blank" rel="noopener noreferrer">${esc(ATTRIBUTION_TEXT)}</a></figcaption></figure>`;
}

/** Failure order: primary -> fallback URL -> placeholder (caption hidden because no dataset picture is shown). */
export function nextMediaStep(img) {
  const fb = img.dataset?.fallback;
  if (fb && img.dataset.tried !== "1") return { action: "fallback", src: fb };
  return { action: "placeholder" };
}

/** Attach the error handling for every dataset media element below `root` (call once per container). */
export function wireDatasetMedia(root) {
  if (!root || root.dataset.dsWired === "1") return;
  root.dataset.dsWired = "1";
  root.addEventListener("error", (event) => {
    const img = event.target;
    if (!img || img.tagName !== "IMG" || !img.closest?.(".ds-media")) return;
    const step = nextMediaStep(img);
    if (step.action === "fallback") { img.dataset.tried = "1"; img.src = step.src; return; }
    const figure = img.closest(".ds-media");
    img.hidden = true;
    figure.classList.add("is-failed");
    figure.querySelector(".ds-placeholder").hidden = false;
    figure.querySelector(".ds-caption").hidden = true;
  }, true);
}
