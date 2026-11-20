import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const REPO = resolve(here, "../..");
export const GOLDEN = JSON.parse(readFileSync(resolve(here, "golden/v1_vectors.json"), "utf8"));
export const INO_PATH = resolve(REPO, "firmware/LiftIQ_BLE/LiftIQ_BLE.ino");
export const PROTOCOL_HEADER_PATH = resolve(REPO, "firmware/LiftIQ_BLE/protocol_v1.h");

export function hexToBytes(hex) {
  const clean = hex.replace(/[^0-9a-fA-F]/g, "");
  return Uint8Array.from(clean.match(/../g) ?? [], (pair) => parseInt(pair, 16));
}

export function hexToView(hex) {
  const bytes = hexToBytes(hex);
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

export function bytesToHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(" ");
}

// Build a v1 telemetry packet the way the firmware encoder lays it out (independent JS model,
// used only to generate packet SEQUENCES for the behavioural tests; the byte contract itself is
// pinned by the golden vectors and the host-compiled firmware encoder).
export function packet({ ax = 0, ay = 0, az = 9.81, total = 9.81, dynamic = 0, seq = 0, phase = 0, status = 0, reps = 0, battery = 4000 } = {}) {
  const view = new DataView(new ArrayBuffer(18));
  [ax, ay, az, total, dynamic].forEach((value, index) => view.setInt16(index * 2, Math.round(value * 100), true));
  view.setUint16(10, seq & 0xffff, true);
  view.setUint8(12, phase);
  view.setUint8(13, status);
  view.setUint16(14, reps & 0xffff, true);
  view.setUint16(16, battery, true);
  return view;
}
