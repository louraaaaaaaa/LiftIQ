// User-supplied machine photos: downscale client-side, store in IndexedDB (store "photos"), show as URLs.
// Photos are local only: never part of CSV exports, deleted together with their (custom) exercise.
export const MAX_PHOTO_PX = 800;
export const JPEG_QUALITY = 0.8;

export function fitSize(width, height, maxPx = MAX_PHOTO_PX) {
  const longest = Math.max(width, height);
  if (!(longest > 0)) throw new Error("The image has no size.");
  if (longest <= maxPx) return { width, height };
  const scale = maxPx / longest;
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** deps.load(file) -> {width, height, ...}; deps.render(image, w, h, mime, quality) -> Blob. */
export async function processPhoto(file, deps, { maxPx = MAX_PHOTO_PX, quality = JPEG_QUALITY } = {}) {
  if (!file || !String(file.type || "").startsWith("image/")) throw new Error("Choose an image file.");
  const image = await deps.load(file);
  const { width, height } = fitSize(image.width, image.height, maxPx);
  const blob = await deps.render(image, width, height, "image/jpeg", quality);
  if (!blob) throw new Error("The photo could not be processed.");
  return { blob, mime: "image/jpeg", width, height };
}

export const browserPhotoDeps = {
  async load(file) {
    if (globalThis.createImageBitmap) {
      try { return await createImageBitmap(file, { imageOrientation: "from-image" }); } catch { /* fall back */ }
    }
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("This image could not be read.")); };
      img.src = url;
    });
  },
  render(image, width, height, mime, quality) {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    canvas.getContext("2d").drawImage(image, 0, 0, width, height);
    return new Promise((resolve) => canvas.toBlob(resolve, mime, quality));
  },
};

const browserUrls = { create: (blob) => URL.createObjectURL(blob), revoke: (url) => URL.revokeObjectURL(url) };

export class PhotoService {
  constructor({ storage, process = (file) => processPhoto(file, browserPhotoDeps), urls = browserUrls, clock = { now: () => Date.now() } }) {
    Object.assign(this, { storage, process, urls, clock });
    this.map = new Map(); // exerciseId -> object URL
  }

  async init() {
    for (const url of this.map.values()) this.urls.revoke(url);
    this.map.clear();
    for (const p of await this.storage.getPhotos()) this.map.set(p.exerciseId, this.urls.create(p.blob));
    return this.map;
  }

  urlFor(exerciseId) { return this.map.get(exerciseId) || null; }

  async set(exerciseId, file) {
    const { blob, mime, width, height } = await this.process(file);
    await this.storage.savePhoto({ exerciseId, blob, mime, width, height, updatedAt: new Date(this.clock.now()).toISOString() });
    const old = this.map.get(exerciseId);
    if (old) this.urls.revoke(old);
    this.map.set(exerciseId, this.urls.create(blob));
    return this.map.get(exerciseId);
  }

  async remove(exerciseId) {
    await this.storage.deletePhoto(exerciseId);
    const old = this.map.get(exerciseId);
    if (old) this.urls.revoke(old);
    this.map.delete(exerciseId);
  }
}
