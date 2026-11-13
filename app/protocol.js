export const SERVICE_UUID = "4fa8691a-1365-4a4f-a808-3fda13b292e0";
export const NOTIFY_UUID = "beb5483e-36e1-4688-b7f5-ea07361b26a8";
export const WRITE_UUID = "cba8691a-1365-4a4f-a808-3fda13b292e0";
export const DEVICE_NAME = "GymIQ Sensor";
export const PHASE_NAMES = ["IDLE", "CONCENTRIC", "ECCENTRIC"];

const PACKET_LENGTH = 18;
const CALIBRATION_STATUS = new Map([[0, null], [1, "started"], [2, "complete"], [3, "failed"]]);
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
    velocity: values[5] / 1000,
    phase,
    calibration,
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
  "actual_rep_count",
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
