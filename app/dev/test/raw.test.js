import assert from "node:assert/strict";
import test from "node:test";
import {
  RAW_CHUNK,
  RAW_CMD,
  RAW_CSV_COLUMNS,
  RAW_STATE,
  RawDownload,
  buildRawCsv,
  encodeRawCommand,
  parseRawChunk,
  parseRawInfo,
  parseRawStatus,
  parseRawStream,
} from "../raw-protocol.js";
import { RawCaptureMachine, LAB } from "../raw-session.js";
import { RAW_UUID } from "../protocol.js";

// ---- synthetic firmware stream helpers ----
const BLOCK = 25;
function makeStream({ count = 100, startTime = 0xFFFF00, gyroBias = [0.5, -0.25, 0.125], gravity = [0.1, 0.2, 9.7], reps = 3 } = {}) {
  const fw = "liftiq-fw s0.2";
  const headerLength = 1 + 4 + 2 + 1 + 2 + 1 + 12 + 12 + 2 + 4 + 1 + fw.length;
  const blocks = Math.ceil(count / BLOCK);
  const bytes = new Uint8Array(2 + headerLength + blocks * 4 + count * 12);
  const view = new DataView(bytes.buffer);
  let o = 0;
  view.setUint16(o, headerLength, true); o += 2;
  view.setUint8(o++, 2);
  view.setUint32(o, count, true); o += 4;
  view.setUint16(o, 200, true); o += 2;
  view.setUint8(o++, 8);
  view.setUint16(o, 1000, true); o += 2;
  view.setUint8(o++, BLOCK);
  for (const v of gyroBias) { view.setFloat32(o, v, true); o += 4; }
  for (const v of gravity) { view.setFloat32(o, v, true); o += 4; }
  view.setUint16(o, reps, true); o += 2;
  view.setUint32(o, 123456, true); o += 4;
  view.setUint8(o++, fw.length);
  for (const ch of fw) view.setUint8(o++, ch.charCodeAt(0));
  for (let n = 0; n < count; n++) {
    if (n % BLOCK === 0) {
      // 5 ms per sample = 128 SENSORTIME LSB; 24-bit counter wraps at 0x1000000
      view.setUint32(o, (startTime + n * 128) & 0xFFFFFF, true);
      o += 4;
    }
    [100 + n, -200, 300, 0, 0, 4096].forEach((v, i) => view.setInt16(o + i * 2, v, true));
    o += 12;
  }
  return bytes;
}

function toChunks(stream, payload) {
  const total = Math.ceil(stream.length / payload);
  const chunks = [];
  for (let i = 0; i < total; i++) chunks.push({ index: i, bytes: stream.slice(i * payload, (i + 1) * payload) });
  return { chunks, info: { payloadSize: payload, totalChunks: total, totalBytes: stream.length } };
}

function chunkView(type, index, payload) {
  const bytes = new Uint8Array(4 + payload.length);
  const view = new DataView(bytes.buffer);
  view.setUint8(0, type);
  view.setUint16(1, index, true);
  view.setUint8(3, payload.length);
  bytes.set(payload, 4);
  return new DataView(bytes.buffer);
}

function infoPayload(info) {
  const p = new Uint8Array(8);
  const v = new DataView(p.buffer);
  v.setUint16(0, info.payloadSize, true);
  v.setUint16(2, info.totalChunks, true);
  v.setUint32(4, info.totalBytes, true);
  return p;
}

function statusPayload({ state = 0, err = 0, arm = 0, flags = 0, count = 0, cap = 8000 } = {}) {
  const p = new Uint8Array(12);
  const v = new DataView(p.buffer);
  v.setUint8(0, state); v.setUint8(1, err); v.setUint8(2, arm); v.setUint8(3, flags);
  v.setUint32(4, count, true); v.setUint32(8, cap, true);
  return p;
}

test("uses the new RAW characteristic UUID defined in protocol.js", () => {
  assert.match(RAW_UUID, /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
});

test("encodes control commands incl. RESEND ranges (little-endian)", () => {
  assert.deepEqual(Array.from(encodeRawCommand(RAW_CMD.ARM)), [0x10]);
  assert.deepEqual(Array.from(encodeRawCommand(RAW_CMD.RESEND, 0x0102, 3)), [0x14, 0x02, 0x01, 0x03, 0x00]);
});

test("parses chunk header, status and info payloads", () => {
  const status = parseRawStatus(parseRawChunk(chunkView(RAW_CHUNK.STATUS, 7, statusPayload({ state: RAW_STATE.ARMING, arm: 40, flags: 3, count: 12, cap: 8000 }))));
  assert.deepEqual(status, { state: 1, errorCode: 0, armPercent: 40, capacityReduced: true, autoStopped: true, sampleCount: 12, capacitySamples: 8000 });
  const info = parseRawInfo(parseRawChunk(chunkView(RAW_CHUNK.INFO, 9, infoPayload({ payloadSize: 16, totalChunks: 9, totalBytes: 130 }))));
  assert.deepEqual(info, { payloadSize: 16, totalChunks: 9, totalBytes: 130 });
  assert.equal(parseRawChunk(new DataView(new ArrayBuffer(3))), null);
  assert.equal(parseRawChunk(new DataView(new Uint8Array([2, 0, 0, 9, 1]).buffer)), null);
});

test("reassembles lost, duplicated and out-of-order chunks and reports missing ranges", () => {
  const stream = makeStream({ count: 100 });
  const { chunks, info } = toChunks(stream, 16);
  const download = new RawDownload();
  assert.equal(download.missingRanges(), null);
  // out of order, a duplicate, and chunks 3-4 and 20 lost
  const order = chunks.filter((c) => ![3, 4, 20].includes(c.index)).reverse();
  for (const c of order) download.addChunk(c.index, c.bytes);
  assert.equal(download.addChunk(order[0].index, order[0].bytes), false);
  assert.equal(download.duplicates, 1);
  download.setInfo(info);
  assert.deepEqual(download.missingRanges(), [{ first: 3, count: 2 }, { first: 20, count: 1 }]);
  assert.equal(download.complete, false);
  assert.throws(() => download.assemble());
  for (const i of [3, 4, 20]) download.addChunk(i, chunks[i].bytes);
  assert.equal(download.complete, true);
  assert.deepEqual(Array.from(download.assemble()), Array.from(stream));
});

test("rejects chunks with the wrong length or index once info is known", () => {
  const stream = makeStream({ count: 10 });
  const { chunks, info } = toChunks(stream, 16);
  const download = new RawDownload();
  download.setInfo(info);
  assert.equal(download.addChunk(0, new Uint8Array(15)), false);
  assert.equal(download.addChunk(info.totalChunks + 5, new Uint8Array(16)), false);
  assert.equal(download.invalid, 2);
  assert.equal(download.addChunk(0, chunks[0].bytes), true);
});

test("parses the v2 header and unwraps the 24-bit block SENSORTIME across the wrap", () => {
  const { header, samples } = parseRawStream(makeStream({ count: 110 }));
  assert.equal(header.sampleCount, 110);
  assert.equal(header.blockSamples, 25);
  assert.equal(header.sampleRateHz, 200);
  assert.equal(header.accelRangeG, 8);
  assert.equal(header.gyroRangeDps, 1000);
  assert.deepEqual(header.gyroBiasDps, [0.5, -0.25, 0.125]);
  assert.equal(header.repCount, 3);
  assert.equal(header.sensortimeBase, 123456);
  assert.equal(header.fwVersion, "liftiq-fw s0.2");
  assert.equal(samples.length, 110);
  assert.equal(samples[0].t_s, 0);
  // 128 LSB * 39.0625 us = 5 ms per sample; the 24-bit counter wraps inside this capture (block 2 crosses 0x1000000)
  assert.ok(Math.abs(samples[1].t_s - 0.005) < 1e-9);
  assert.ok(Math.abs(samples[25].t_s - 0.125) < 1e-9);
  assert.ok(Math.abs(samples[109].t_s - 0.545) < 1e-6);
  for (let i = 1; i < samples.length; i++) assert.ok(samples[i].t_s > samples[i - 1].t_s);
  // unit conversion: accel 4096 LSB at +/-8 g = 1 g; gyro 100 LSB / 32.8
  assert.ok(Math.abs(samples[0].az - 9.81) < 1e-9);
  assert.ok(Math.abs(samples[0].gx - 100 / 32.8) < 1e-9);
  assert.throws(() => parseRawStream(new Uint8Array(1)));
  const v1 = makeStream({ count: 10 });
  v1[2] = 1;
  assert.throws(() => parseRawStream(v1), /version/);
});

test("generates Raw CSV v1 with the exact header keys and column row", () => {
  const parsed = parseRawStream(makeStream({ count: 3 }));
  const csv = buildRawCsv(parsed, { deviceName: "LiftIQ-TEST", capturedAt: "2026-11-20T10:00:00.000Z", droppedChunks: 2, exercise: "Back squat", loadKg: "100", knownRomCm: "45", notes: "line1\nline2" });
  const lines = csv.trimEnd().split("\n");
  const keys = lines.filter((l) => l.startsWith("# ")).map((l) => l.slice(2, l.indexOf(":")));
  assert.deepEqual(keys, [
    "format", "fw_version", "device_name", "app_version", "captured_at", "sample_rate_hz", "accel_range_g",
    "gyro_range_dps", "accel_units", "gyro_units", "gyro_bias_dps", "gravity_ms2", "rep_count_firmware",
    "dropped_chunks", "exercise", "load_kg", "known_rom_cm", "notes",
  ]);
  assert.equal(lines[0], "# format: liftiq-raw v1");
  assert.ok(lines.includes("# gyro_bias_dps: 0.5;-0.25;0.125"));
  assert.ok(lines.includes("# notes: line1 line2"));
  assert.ok(lines.includes("# accel_units: m/s^2"));
  assert.ok(lines.includes("# dropped_chunks: 2"));
  assert.deepEqual(RAW_CSV_COLUMNS, ["t_s", "ax", "ay", "az", "gx", "gy", "gz"]);
  assert.equal(lines[18], "t_s,ax,ay,az,gx,gy,gz");
  assert.equal(lines.length, 19 + 3);
  assert.equal(lines[19].split(",").length, 7);
  assert.equal(lines[19].split(",")[0], "0.000000");
});

// ---- Lab state machine with a fake firmware link ----
class FakeClock {
  constructor() { this.time = 1_700_000_000_000; this.timers = new Map(); this.nextId = 1; }
  now() { return this.time; }
  setTimeout(fn, ms) { const id = this.nextId++; this.timers.set(id, { fn, at: this.time + ms }); return id; }
  clearTimeout(id) { this.timers.delete(id); }
  advance(ms) {
    const target = this.time + ms;
    for (;;) {
      const due = [...this.timers.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.timers.delete(due[0]);
      this.time = due[1].at;
      due[1].fn();
    }
    this.time = target;
  }
}

function labSetup({ dropFirstPass = [], count = 100 } = {}) {
  const clock = new FakeClock();
  const stream = makeStream({ count });
  const { chunks, info } = toChunks(stream, 16);
  const written = [];
  const saved = [];
  let machine;
  const deliverRange = (first, last, { skip = [] } = {}) => {
    for (let i = first; i < last; i++) {
      if (skip.includes(i)) continue;
      machine.onChunk(parseRawChunk(chunkView(RAW_CHUNK.DATA, i, chunks[i].bytes)));
    }
    machine.onChunk(parseRawChunk(chunkView(RAW_CHUNK.DONE, info.totalChunks, infoPayload(info))));
  };
  const ble = {
    async writeRaw(bytes) {
      written.push(Array.from(bytes));
      if (bytes[0] === RAW_CMD.DOWNLOAD) {
        machine.onChunk(parseRawChunk(chunkView(RAW_CHUNK.INFO, info.totalChunks, infoPayload(info))));
        deliverRange(0, info.totalChunks, { skip: dropFirstPass });
      } else if (bytes[0] === RAW_CMD.RESEND) {
        const first = bytes[1] | (bytes[2] << 8);
        const n = bytes[3] | (bytes[4] << 8);
        deliverRange(first, first + n);
      }
    },
  };
  machine = new RawCaptureMachine({ ble, storage: { saveRaw: async (r) => { saved.push(r); } }, clock, uuid: () => "raw-1", idleTimeoutMs: 1000, maxStalls: 2 });
  machine.setSupported(true);
  machine.bleConnected();
  const status = (fields) => machine.onChunk(parseRawChunk(chunkView(RAW_CHUNK.STATUS, 0, statusPayload(fields))));
  return { machine, written, saved, clock, status, info, stream };
}

test("Lab: arm -> armed -> capturing -> stop auto-downloads and recovers lost chunks with RESEND", async () => {
  const ctx = labSetup({ dropFirstPass: [3, 4, 20] });
  ctx.status({ state: RAW_STATE.IDLE });
  assert.equal(ctx.machine.snapshot().canArm, true);
  await ctx.machine.arm();
  assert.deepEqual(ctx.written[0], [RAW_CMD.ARM]);
  ctx.status({ state: RAW_STATE.ARMING, arm: 50 });
  assert.equal(ctx.machine.state, LAB.ARMING);
  assert.equal(ctx.machine.busy, true);
  ctx.status({ state: RAW_STATE.ARMED, arm: 100 });
  assert.equal(ctx.machine.snapshot().canStart, true);
  await ctx.machine.start();
  ctx.status({ state: RAW_STATE.CAPTURING, count: 400 });
  assert.equal(ctx.machine.snapshot().canStop, true);
  await ctx.machine.stop();
  ctx.status({ state: RAW_STATE.READY, count: 100 });   // triggers the automatic download
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ctx.machine.state, LAB.DOWNLOADED);
  assert.equal(ctx.machine.droppedChunks, 3);
  const resends = ctx.written.filter((w) => w[0] === RAW_CMD.RESEND);
  assert.deepEqual(resends.map((w) => [w[1] | (w[2] << 8), w[3] | (w[4] << 8)]), [[3, 2], [20, 1]]);
  assert.equal(ctx.machine.capture.samples.length, 100);
});

test("Lab: save stores the CSV, then erases the sensor", async () => {
  const ctx = labSetup();
  ctx.status({ state: RAW_STATE.READY, count: 100 });
  await ctx.machine.startDownload();
  assert.equal(ctx.machine.state, LAB.DOWNLOADED);
  const record = await ctx.machine.save({ exercise: "Row", loadKg: "60", knownRomCm: "30", notes: "n", deviceName: "LiftIQ-T" });
  assert.equal(record.sampleCount, 100);
  assert.match(record.csv, /^# format: liftiq-raw v1\n/);
  assert.equal(ctx.saved.length, 1);
  assert.deepEqual(ctx.written.at(-1), [RAW_CMD.ERASE]);
  assert.equal(ctx.machine.capture, null);
});

test("Lab: a stalled download retries, then gives up with a clear error and keeps data on the sensor", async () => {
  const clock = new FakeClock();
  const written = [];
  const machine = new RawCaptureMachine({ ble: { writeRaw: async (b) => { written.push(Array.from(b)); } }, storage: {}, clock, idleTimeoutMs: 1000, maxStalls: 2 });
  machine.setSupported(true);
  machine.bleConnected();
  machine.onChunk(parseRawChunk(chunkView(RAW_CHUNK.STATUS, 0, statusPayload({ state: RAW_STATE.READY, count: 10 }))));
  await machine.startDownload();
  clock.advance(1000); await Promise.resolve();
  clock.advance(1000); await Promise.resolve();
  clock.advance(1000); await Promise.resolve();
  assert.equal(machine.state, LAB.ERROR);
  assert.match(machine.snapshot().error, /still on the sensor/);
  assert.equal(written.filter((w) => w[0] === RAW_CMD.DOWNLOAD).length, 3);
});

test("Lab: disconnect mid-download keeps the partial data and resumes with RESEND after reconnect", async () => {
  const ctx = labSetup();
  ctx.status({ state: RAW_STATE.READY, count: 100 });
  // deliver only part of the stream, no DONE
  ctx.machine.download = null;
  const origWrite = ctx.machine.ble.writeRaw;
  ctx.machine.ble.writeRaw = async (bytes) => { ctx.written.push(Array.from(bytes)); };   // swallow DOWNLOAD
  await ctx.machine.startDownload();
  const { chunks, info } = toChunks(ctx.stream, 16);
  ctx.machine.onChunk(parseRawChunk(chunkView(RAW_CHUNK.INFO, info.totalChunks, infoPayload(info))));
  for (let i = 0; i < 10; i++) ctx.machine.onChunk(parseRawChunk(chunkView(RAW_CHUNK.DATA, i, chunks[i].bytes)));
  ctx.machine.bleDisconnected();
  assert.equal(ctx.machine.state === LAB.DOWNLOADING, false);
  assert.match(ctx.machine.snapshot().message, /stays on the sensor/);
  ctx.machine.bleConnected();
  ctx.status({ state: RAW_STATE.READY, count: 100 });
  assert.equal(ctx.machine.snapshot().canDownload, true);
  ctx.machine.ble.writeRaw = origWrite;
  await ctx.machine.startDownload();
  await new Promise((resolve) => setImmediate(resolve));
  const resend = ctx.written.filter((w) => w[0] === RAW_CMD.RESEND).pop();
  assert.equal(resend[1] | (resend[2] << 8), 10);   // resumes at the first missing chunk
  assert.equal(ctx.machine.state, LAB.DOWNLOADED);
});

test("Lab: raw capture is blocked while a live set runs and reports busy to block live sets", async () => {
  const clock = new FakeClock();
  let live = true;
  const machine = new RawCaptureMachine({ ble: { writeRaw: async () => {} }, storage: {}, clock, canRun: () => !live });
  machine.setSupported(true);
  machine.bleConnected();
  machine.onChunk(parseRawChunk(chunkView(RAW_CHUNK.STATUS, 0, statusPayload({ state: RAW_STATE.IDLE }))));
  assert.equal(machine.snapshot().canArm, false);
  live = false;
  assert.equal(machine.snapshot().canArm, true);
  machine.onChunk(parseRawChunk(chunkView(RAW_CHUNK.STATUS, 0, statusPayload({ state: RAW_STATE.CAPTURING }))));
  assert.equal(machine.busy, true);
});
