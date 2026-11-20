import assert from "node:assert/strict";
import test from "node:test";
import { BleClient } from "../ble.js";
import { APP_VERSION, CHANNEL } from "../channel.js";
import {
  CAPABILITY_RAW_CAPTURE,
  INFO_LENGTH,
  INFO_UUID,
  NOTIFY_UUID,
  RAW_UUID,
  SERVICE_UUID,
  WRITE_UUID,
  describeInfo,
  parseInfo,
} from "../protocol.js";
import { RawCaptureMachine } from "../raw-session.js";
import { Views } from "../ui.js";

function infoView({ major = 1, minor = 1, caps = CAPABILITY_RAW_CAPTURE, fw = "liftiq-fw s0.2" } = {}) {
  const view = new DataView(new ArrayBuffer(INFO_LENGTH));
  view.setUint8(0, major);
  view.setUint8(1, minor);
  view.setUint16(2, caps, true);
  for (let i = 0; i < fw.length; i++) view.setUint8(4 + i, fw.charCodeAt(i));
  return view;
}

// Fake Web Bluetooth GATT tree; `missing` lists characteristic UUIDs the "firmware" lacks.
function fakeBluetooth({ missing = [], infoThrows = false } = {}) {
  const notNotify = new Set(missing);
  const characteristic = (uuid) => ({
    uuid,
    addEventListener() {},
    removeEventListener() {},
    async startNotifications() {},
    async readValue() {
      if (uuid === INFO_UUID) {
        if (infoThrows) throw new Error("read not permitted");
        return infoView();
      }
      return new DataView(new ArrayBuffer(18));
    },
    async writeValue() {},
  });
  const service = {
    async getCharacteristic(uuid) {
      if (notNotify.has(uuid)) throw Object.assign(new Error("No Characteristics matching UUID found"), { name: "NotFoundError" });
      return characteristic(uuid);
    },
  };
  const device = {
    name: "LiftIQ-TEST",
    addEventListener() {},
    removeEventListener() {},
    gatt: {
      connected: false,
      async connect() { device.gatt.connected = true; return { getPrimaryService: async (uuid) => { assert.equal(uuid, SERVICE_UUID); return service; } }; },
      disconnect() { device.gatt.connected = false; },
    },
  };
  return { requestDevice: async () => device };
}

async function connectWith(options) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { value: { bluetooth: fakeBluetooth(options) }, configurable: true, writable: true });
  try {
    const client = new BleClient({ onPacket() {}, onDisconnect() {} });
    await client.connect();
    return client;
  } finally {
    if (previous) Object.defineProperty(globalThis, "navigator", previous);
    else delete globalThis.navigator;
  }
}

test("INFO characteristic: decodes protocol, capabilities and firmware string", () => {
  const info = parseInfo(infoView());
  assert.deepEqual(info, { protocolMajor: 1, protocolMinor: 1, capabilities: 1, rawCapture: true, firmware: "liftiq-fw s0.2" });
  assert.equal(describeInfo(info), "liftiq-fw s0.2 · protocol 1.1");
  assert.equal(parseInfo(infoView({ caps: 0 })).rawCapture, false);
  assert.equal(parseInfo(new DataView(new ArrayBuffer(2))), null);
  assert.match(describeInfo(null), /Unknown/);
});

test("INFO UUID is distinct from every other characteristic", () => {
  assert.equal(new Set([NOTIFY_UUID, WRITE_UUID, RAW_UUID, INFO_UUID]).size, 4);
});

test("connect succeeds on current firmware (RAW + INFO present)", async () => {
  const client = await connectWith({});
  assert.equal(client.rawSupported, true);
  assert.equal(client.info.firmware, "liftiq-fw s0.2");
});

test("connect succeeds on OLDER firmware without RAW and INFO characteristics", async () => {
  const client = await connectWith({ missing: [RAW_UUID, INFO_UUID] });
  assert.equal(client.isConnected(), true);
  assert.equal(client.rawSupported, false);
  assert.equal(client.info, null);
  assert.ok(client.notifyCharacteristic && client.writeCharacteristic);
});

test("connect succeeds when only INFO is missing, or INFO cannot be read", async () => {
  const noInfo = await connectWith({ missing: [INFO_UUID] });
  assert.equal(noInfo.rawSupported, true);
  assert.equal(noInfo.info, null);
  const unreadable = await connectWith({ infoThrows: true });
  assert.equal(unreadable.isConnected(), true);
  assert.equal(unreadable.info, null);
});

test("Lab says 'not supported by this sensor firmware' on a connected old sensor", () => {
  const machine = new RawCaptureMachine({ ble: {}, storage: {}, clock: { now: () => 0, setTimeout: () => 0, clearTimeout() {} } });
  machine.setSupported(false);
  machine.bleConnected();
  const snapshot = machine.snapshot();
  assert.equal(snapshot.connected, true);
  assert.equal(snapshot.supported, false);
  assert.equal(snapshot.canArm, false);

  const el = new Proxy({}, { get: (target, key) => (target[key] ??= { textContent: "", classList: { toggle() {}, add() {}, remove() {} }, style: {}, dataset: {}, setAttribute() {} }) });
  const views = new Views(el);
  views.renderLab(snapshot, false);
  assert.match(el.labIntro.textContent, /not supported by this sensor firmware/);
});

test("channel markers are consistent (dev build carries -dev, a released stable build does not)", () => {
  assert.ok(["dev", "stable"].includes(CHANNEL));
  assert.equal(APP_VERSION.endsWith("-dev"), CHANNEL === "dev");
});
