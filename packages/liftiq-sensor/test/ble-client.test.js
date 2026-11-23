// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import { BleClient, WebBluetoothTransport } from "../src/index.js";
import {
  CAPABILITY_RAW_CAPTURE,
  DEVICE_FILTERS,
  INFO_LENGTH,
  INFO_UUID,
  NOTIFY_UUID,
  RAW_UUID,
  SERVICE_UUID,
  WRITE_UUID,
} from "../src/protocol.js";

function infoView(fw = "liftiq-fw s0.2") {
  const view = new DataView(new ArrayBuffer(INFO_LENGTH));
  view.setUint8(0, 1);
  view.setUint8(1, 1);
  view.setUint16(2, CAPABILITY_RAW_CAPTURE, true);
  for (let i = 0; i < fw.length; i++) view.setUint8(4 + i, fw.charCodeAt(i));
  return view;
}

function telemetryView({ seq = 1, reps = 3 } = {}) {
  const view = new DataView(new ArrayBuffer(18));
  [100, 0, 981, 981, 5].forEach((value, index) => view.setInt16(index * 2, value, true));
  view.setUint16(10, seq, true);
  view.setUint8(12, 0);
  view.setUint8(13, 2);
  view.setUint16(14, reps, true);
  view.setUint16(16, 3900, true);
  return view;
}

// In-memory BleTransport: the same contract a Capacitor transport has to satisfy.
class FakeTransport {
  constructor({ missing = [], infoThrows = false, supported = true } = {}) {
    this.missing = new Set(missing);
    this.infoThrows = infoThrows;
    this.supported = supported;
    this.calls = [];
    this.connected = false;
    this.device = { name: "LiftIQ-TEST" };
    this.handlers = new Map(); // characteristic uuid -> onValue
    this.disconnectCb = null;
    this.writes = [];
    this.stopped = [];
  }

  isSupported() { return this.supported; }

  async requestDevice(filters, optionalServices) {
    this.calls.push(["requestDevice", filters, optionalServices]);
    return this.device;
  }

  async connect(device) { assert.equal(device, this.device); this.connected = true; }
  disconnect() { if (this.connected) { this.connected = false; this.disconnectCb?.(); } }
  isConnected() { return this.connected; }

  async getCharacteristic(device, serviceUuid, uuid) {
    assert.equal(serviceUuid, SERVICE_UUID);
    if (this.missing.has(uuid)) throw Object.assign(new Error("No Characteristics matching UUID found"), { name: "NotFoundError" });
    return { uuid };
  }

  async startNotifications(characteristic, onValue) { this.handlers.set(characteristic.uuid, onValue); }
  async stopNotifications(characteristic) { this.handlers.delete(characteristic.uuid); this.stopped.push(characteristic.uuid); }

  async readValue(characteristic) {
    if (characteristic.uuid === INFO_UUID) {
      if (this.infoThrows) throw new Error("read not permitted");
      return infoView();
    }
    return telemetryView({ seq: 99, reps: 7 });
  }

  async writeValue(characteristic, bytes) { this.writes.push([characteristic.uuid, [...bytes]]); }

  onDisconnect(device, callback) {
    this.disconnectCb = callback;
    return () => { this.disconnectCb = null; };
  }
}

function makeClient(options) {
  const transport = new FakeTransport(options);
  const events = { packets: [], invalid: [], raw: [], disconnects: 0 };
  const client = new BleClient({
    transport,
    onPacket: (reading) => events.packets.push(reading),
    onInvalidPacket: (view) => events.invalid.push(view.byteLength),
    onRawChunk: (chunk) => events.raw.push(chunk),
    onDisconnect: () => { events.disconnects += 1; },
  });
  return { transport, client, events };
}

test("connect uses the LiftIQ filters, the service UUID and the transport only", async () => {
  const { transport, client } = makeClient();
  assert.equal(BleClient.isSupported(transport), true);
  assert.equal(BleClient.isSupported(new FakeTransport({ supported: false })), false);
  await client.connect();
  assert.deepEqual(transport.calls[0], ["requestDevice", DEVICE_FILTERS, [SERVICE_UUID]]);
  assert.equal(client.isConnected(), true);
  assert.equal(client.name, "LiftIQ-TEST");
  assert.equal(client.rawSupported, true);
  assert.equal(client.info.firmware, "liftiq-fw s0.2");
  assert.ok(transport.handlers.has(NOTIFY_UUID) && transport.handlers.has(RAW_UUID));
});

test("notifications are decoded and routed; invalid packets are reported", async () => {
  const { transport, client, events } = makeClient();
  await client.connect();
  transport.handlers.get(NOTIFY_UUID)(telemetryView({ seq: 5, reps: 4 }));
  transport.handlers.get(NOTIFY_UUID)(new DataView(new ArrayBuffer(5)));
  assert.equal(events.packets.length, 1);
  assert.equal(events.packets[0].repCount, 4);
  assert.deepEqual(events.invalid, [5]);
});

test("older firmware without RAW and INFO characteristics still connects", async () => {
  const { client } = makeClient({ missing: [RAW_UUID, INFO_UUID] });
  await client.connect();
  assert.equal(client.isConnected(), true);
  assert.equal(client.rawSupported, false);
  assert.equal(client.info, null);
  assert.ok(client.notifyCharacteristic && client.writeCharacteristic);
});

test("an unreadable INFO characteristic never fails the connection", async () => {
  const { client } = makeClient({ infoThrows: true });
  await client.connect();
  assert.equal(client.isConnected(), true);
  assert.equal(client.info, null);
});

test("a missing notify characteristic fails the connect, disconnects and cleans up", async () => {
  const { transport, client } = makeClient({ missing: [NOTIFY_UUID] });
  await assert.rejects(client.connect(), /No Characteristics/);
  assert.equal(transport.connected, false);
  assert.equal(client.device, null);
  assert.equal(client.isConnected(), false);
});

test("write, readValue and sendThresholds go through the transport; they reject when disconnected", async () => {
  const { transport, client } = makeClient();
  await assert.rejects(client.write(new Uint8Array([1])), /not connected/);
  await assert.rejects(client.readValue(), /not connected/);
  await client.connect();
  await client.write(new Uint8Array([1]));
  await client.sendThresholds({ start: 1, reversal: 0.35, rest: 0.45 });
  assert.deepEqual(transport.writes[0], [WRITE_UUID, [1]]);
  assert.equal(transport.writes[1][1][0], 0x02);
  assert.equal(transport.writes[1][1].length, 7);
  assert.equal((await client.readValue()).getUint16(14, true), 7);
});

test("a remote disconnect tears the client down and notifies once", async () => {
  const { transport, client, events } = makeClient();
  await client.connect();
  transport.connected = false;
  transport.disconnectCb();
  assert.equal(events.disconnects, 1);
  assert.equal(client.isConnected(), false);
  assert.equal(client.device, null);
  assert.equal(client.rawSupported, false);
  assert.deepEqual([...transport.stopped].sort(), [NOTIFY_UUID, RAW_UUID].sort());
  assert.equal(transport.disconnectCb, null);
});

// ---- default WebBluetoothTransport against a fake navigator.bluetooth -----------------------------------
function fakeNavigatorBluetooth({ missing = [] } = {}) {
  const listeners = new Map();
  const characteristic = (uuid) => ({
    uuid,
    addEventListener(type, fn) { listeners.set(uuid, fn); },
    removeEventListener() { listeners.delete(uuid); },
    async startNotifications() {},
    async stopNotifications() {},
    async readValue() { return uuid === INFO_UUID ? infoView() : telemetryView(); },
    async writeValue() {},
  });
  const service = {
    async getCharacteristic(uuid) {
      if (missing.includes(uuid)) throw new Error("not found");
      return characteristic(uuid);
    },
  };
  const device = {
    name: "LiftIQ-WEB",
    addEventListener() {},
    removeEventListener() {},
    gatt: {
      connected: false,
      // like Web Bluetooth, connect() resolves with the server; a separate object here proves the transport uses it
      async connect() { device.gatt.connected = true; return { getPrimaryService: async (uuid) => { assert.equal(uuid, SERVICE_UUID); return service; } }; },
      disconnect() { device.gatt.connected = false; },
    },
  };
  return { api: { requestDevice: async () => device }, listeners };
}

test("WebBluetoothTransport is the default and works against navigator.bluetooth", async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const { api, listeners } = fakeNavigatorBluetooth({ missing: [RAW_UUID] });
  Object.defineProperty(globalThis, "navigator", { value: { bluetooth: api }, configurable: true, writable: true });
  try {
    assert.equal(BleClient.isSupported(), true);
    assert.equal(new WebBluetoothTransport().isSupported(), true);
    const packets = [];
    const client = new BleClient({ onPacket: (r) => packets.push(r), onDisconnect() {} });
    await client.connect();
    assert.equal(client.isConnected(), true);
    assert.equal(client.rawSupported, false);
    assert.equal(client.info.firmware, "liftiq-fw s0.2");
    listeners.get(NOTIFY_UUID)({ target: { value: telemetryView({ reps: 9 }) } });
    assert.equal(packets[0].repCount, 9);
    client.disconnect();
    assert.equal(client.isConnected(), false);
  } finally {
    if (previous) Object.defineProperty(globalThis, "navigator", previous);
    else delete globalThis.navigator;
  }
});

test("isSupported is false without navigator.bluetooth and importing needs no DOM", () => {
  assert.equal(typeof document, "undefined");
  const previous = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { value: {}, configurable: true, writable: true });
  try {
    assert.equal(new WebBluetoothTransport().isSupported(), false);
  } finally {
    if (previous) Object.defineProperty(globalThis, "navigator", previous);
    else delete globalThis.navigator;
  }
});
