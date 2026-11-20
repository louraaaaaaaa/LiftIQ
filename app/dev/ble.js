import { parseRawChunk } from "./raw-protocol.js";
import {
  DEVICE_FILTERS,
  LEGACY_DEVICE_NAME,
  NOTIFY_UUID,
  INFO_UUID,
  RAW_UUID,
  SERVICE_UUID,
  parseInfo,
  WRITE_UUID,
  decodeTelemetry,
  encodeRepThresholds,
} from "./protocol.js";

// Thin Web Bluetooth wrapper. Notifications stay enabled for the whole
// connection (the battery and calibration indicators need packets even
// between sets). Implements the interface SessionMachine expects:
// write(bytes), readValue(), isConnected().
export class BleClient {
  constructor({ onPacket, onInvalidPacket, onDisconnect, onRawChunk = () => {} }) {
    this.onRawChunk = onRawChunk;
    this.rawCharacteristic = null;
    this.info = null;
    this.handleRawValue = (event) => this.onRawChunk(parseRawChunk(event.target.value));
    this.onPacket = onPacket;
    this.onInvalidPacket = onInvalidPacket;
    this.onDisconnect = onDisconnect;
    this.device = null;
    this.notifyCharacteristic = null;
    this.writeCharacteristic = null;
    this.handleValue = (event) => {
      const dataView = event.target.value;
      const reading = decodeTelemetry(dataView);
      if (reading) this.onPacket(reading, dataView);
      else this.onInvalidPacket?.(dataView);
    };
    this.handleDisconnect = () => {
      this.#teardown();
      this.onDisconnect();
    };
  }

  static isSupported() {
    return "bluetooth" in navigator;
  }

  get name() {
    return this.device?.name || LEGACY_DEVICE_NAME;
  }

  isConnected() {
    return Boolean(this.device?.gatt?.connected);
  }

  async connect() {
    // Must run from a user gesture (Web Bluetooth requirement).
    const device = await navigator.bluetooth.requestDevice({
      filters: DEVICE_FILTERS,
      optionalServices: [SERVICE_UUID],
    });
    this.device = device;
    device.addEventListener("gattserverdisconnected", this.handleDisconnect);
    try {
      const server = await device.gatt.connect();
      const service = await server.getPrimaryService(SERVICE_UUID);
      this.notifyCharacteristic = await service.getCharacteristic(NOTIFY_UUID);
      this.writeCharacteristic = await service.getCharacteristic(WRITE_UUID);
      this.notifyCharacteristic.addEventListener("characteristicvaluechanged", this.handleValue);
      await this.notifyCharacteristic.startNotifications();
      // Research-capture characteristic: absent on older firmware (Lab page then stays disabled).
      try {
        this.rawCharacteristic = await service.getCharacteristic(RAW_UUID);
        this.rawCharacteristic.addEventListener("characteristicvaluechanged", this.handleRawValue);
        await this.rawCharacteristic.startNotifications();
      } catch {
        this.rawCharacteristic = null;
      }
      // Optional INFO characteristic (firmware/protocol version). Absent or unreadable on
      // older firmware: that must never fail the connection.
      this.info = null;
      try {
        const infoCharacteristic = await service.getCharacteristic(INFO_UUID);
        this.info = parseInfo(await infoCharacteristic.readValue());
      } catch {
        this.info = null;
      }
    } catch (error) {
      this.disconnect();
      this.#teardown();
      throw error;
    }
  }

  disconnect() {
    if (this.device?.gatt?.connected) this.device.gatt.disconnect();
  }

  #teardown() {
    this.device?.removeEventListener("gattserverdisconnected", this.handleDisconnect);
    this.notifyCharacteristic?.removeEventListener("characteristicvaluechanged", this.handleValue);
    this.rawCharacteristic?.removeEventListener("characteristicvaluechanged", this.handleRawValue);
    this.rawCharacteristic = null;
    this.info = null;
    this.device = null;
    this.notifyCharacteristic = null;
    this.writeCharacteristic = null;
  }

  async write(bytes) {
    if (!this.writeCharacteristic || !this.isConnected()) throw new Error("Sensor is not connected.");
    await this.writeCharacteristic.writeValue(bytes);
  }

  get rawSupported() {
    return Boolean(this.rawCharacteristic);
  }

  writeRaw(bytes) {
    return this.write(bytes);
  }

  async readRawStatus() {
    if (!this.rawCharacteristic || !this.isConnected()) return null;
    return parseRawChunk(await this.rawCharacteristic.readValue());
  }

  async readValue() {
    if (!this.notifyCharacteristic || !this.isConnected()) throw new Error("Sensor is not connected.");
    return this.notifyCharacteristic.readValue();
  }

  async sendThresholds(thresholds) {
    await this.write(encodeRepThresholds(thresholds));
  }
}
