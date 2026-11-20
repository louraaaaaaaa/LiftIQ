export const SERVICE_UUID = "4fa8691a-1365-4a4f-a808-3fda13b292e0";
export const NOTIFY_UUID = "beb5483e-36e1-4688-b7f5-ea07361b26a8";
export const WRITE_UUID = "cba8691a-1365-4a4f-a808-3fda13b292e0";
// Firmware advertises "LiftIQ-XXXX" (last two BT MAC bytes); older firmware
// advertised the fixed name below.
export const DEVICE_NAME_PREFIX = "LiftIQ";
export const LEGACY_DEVICE_NAME = "GymIQ Sensor";
export const DEVICE_FILTERS = [
  { services: [SERVICE_UUID] },
  { namePrefix: DEVICE_NAME_PREFIX },
  { name: LEGACY_DEVICE_NAME },
];
// Firmware notification rate (100 Hz IMU schedule, one notification every 2nd sample).
// MUST match NOTIFY_EVERY_N_SAMPLES / SAMPLE_PERIOD_US in LiftIQ_BLE.ino. Sensor time of a
// sample is (seq - firstSeq) / NOTIFY_HZ.
export const NOTIFY_HZ = 50;
export const PHASE_NAMES = ["IDLE", "CONCENTRIC", "ECCENTRIC"];

const PACKET_LENGTH = 18;
// Byte 13 is PERSISTENT firmware state present in every packet:
// 0 = not calibrated since boot, 1 = calibrating, 2 = calibrated / tracking reps, 3 = failed.
const CALIBRATION_STATUS = new Map([[0, null], [1, "started"], [2, "complete"], [3, "failed"]]);
const BATTERY_EMPTY_MILLIVOLTS = 3300;
const BATTERY_FULL_MILLIVOLTS = 4200;
export const DEFAULT_REP_THRESHOLDS = {
  start: 1.0,
  reversal: 0.35,
  rest: 0.45,
};
export const REP_THRESHOLD_LIMITS = {
  start: { min: 0.1, max: 5.0 },
  reversal: { min: 0.1, max: 3.0 },
  rest: { min: 0.1, max: 3.0 },
};

export function estimateBatteryPercentage(millivolts) {
  if (!Number.isFinite(millivolts)) {
    throw new TypeError("Battery voltage must be a finite number of millivolts.");
  }
  const fraction = (millivolts - BATTERY_EMPTY_MILLIVOLTS) /
    (BATTERY_FULL_MILLIVOLTS - BATTERY_EMPTY_MILLIVOLTS);
  return Math.round(Math.max(0, Math.min(1, fraction)) * 100);
}

// Classify the battery field of a packet. mv is null/undefined before the first
// 18-byte packet (or on legacy packets), 0 when the ADC pin reads 0 mV (no LiPo
// attached / USB only), otherwise an estimate from the linear 3.3-4.2 V model.
export function describeBattery(millivolts) {
  if (millivolts === null || millivolts === undefined) return { kind: "waiting" };
  if (!Number.isFinite(millivolts)) return { kind: "waiting" };
  if (millivolts === 0) {
    return {
      kind: "none",
      millivolts: 0,
      message: "Reads 0 V - no battery detected (running from USB, or battery sense not wired?)",
    };
  }
  return {
    kind: "ok",
    millivolts,
    volts: millivolts / 1000,
    percent: estimateBatteryPercentage(millivolts),
  };
}

export function packetToHex(dataView) {
  const bytes = new Uint8Array(dataView.buffer, dataView.byteOffset, dataView.byteLength);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(" ");
}

export function encodeRepThresholds(thresholds) {
  const values = ["start", "reversal", "rest"].map((key) => {
    const value = Number(thresholds[key]);
    const { min, max } = REP_THRESHOLD_LIMITS[key];
    if (!Number.isFinite(value) || value < min || value > max) {
      throw new RangeError(`${key} threshold must be between ${min} and ${max} m/s².`);
    }
    return Math.round(value * 100);
  });
  const command = new Uint8Array(7);
  const view = new DataView(command.buffer);
  command[0] = 0x02;
  values.forEach((value, index) => view.setUint16(1 + index * 2, value, true));
  return command;
}

export function decodeTelemetry(dataView) {
  if (
    !(dataView instanceof DataView) ||
    (dataView.byteLength !== 16 && dataView.byteLength !== PACKET_LENGTH)
  ) {
    return null;
  }

  const values = Array.from({ length: 6 }, (_, index) =>
    dataView.getInt16(index * 2, true)
  );
  const phase = dataView.getUint8(12);
  const calibration = CALIBRATION_STATUS.get(dataView.getUint8(13));
  if (phase >= PHASE_NAMES.length || calibration === undefined) {
    return null;
  }

  return {
    ax: values[0] / 100,
    ay: values[1] / 100,
    az: values[2] / 100,
    totalAccel: values[3] / 100,
    dynamicAccel: values[4] / 100,
    phase,
    calibration,
    calibrationCode: dataView.getUint8(13),
    // Wrapping uint16 sample sequence; legacy 16-byte packets carry none.
    seq: dataView.byteLength === PACKET_LENGTH ? dataView.getUint16(10, true) : null,
    repCount: dataView.getUint16(14, true),
    batteryMillivolts: dataView.byteLength === PACKET_LENGTH
      ? dataView.getUint16(16, true)
      : null,
  };
}

export const CSV_COLUMNS = [
  "elapsed_s",
  "ax_m_s2",
  "ay_m_s2",
  "az_m_s2",
  "total_accel_m_s2",
  "dynamic_accel_m_s2",
  "phase",
  "phase_id",
  "rep_count",
  "seq",
  "actual_rep_count",
  "arrival_s",
];

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function createSessionCsv(records) {
  return [
    CSV_COLUMNS.join(","),
    ...records.map((record) => CSV_COLUMNS.map((column) => csvCell(record[column])).join(",")),
  ].join("\r\n") + "\r\n";
}
