// LiftIQ BLE protocol v1 - pure encoders (no Arduino / ESP / BLE includes).
//
// This header is the single implementation of the byte layouts that docs/PROTOCOL.md
// freezes. The sketch calls it, and tests/compat/host/encode_v1.cpp compiles the very same
// code on the host and checks it against the golden vectors, so a change here that alters
// the v1 bytes fails CI before it can reach a board.
//
// RULES (docs/PROTOCOL.md "Extension rules"): never change the meaning or length of an
// existing byte; add new data on NEW characteristics; this file only grows additively.
#ifndef LIFTIQ_PROTOCOL_V1_H
#define LIFTIQ_PROTOCOL_V1_H

#include <stdint.h>
#include <string.h>
#include <math.h>   // lroundf (only math function used; available on every toolchain here)

// Protocol version reported by the INFO characteristic. Major changes only with a new
// parallel protocol; minor grows when additive features (new characteristics/opcodes) land.
//   1.0 = original telemetry + control characteristics
//   1.1 = + RAW capture characteristic / opcodes 0x10-0x15, + INFO characteristic
#define LIFTIQ_PROTOCOL_MAJOR 1
#define LIFTIQ_PROTOCOL_MINOR 1

#define LIFTIQ_TELEMETRY_V1_LENGTH 18
#define LIFTIQ_INFO_LENGTH 20
#define LIFTIQ_INFO_FW_MAX 16

// INFO capabilities bitmask (u16)
#define LIFTIQ_CAP_RAW_CAPTURE 0x0001

// Values of telemetry byte 13 (persistent calibration status, present in every packet).
#define LIFTIQ_CAL_NONE 0
#define LIFTIQ_CAL_CALIBRATING 1
#define LIFTIQ_CAL_CALIBRATED 2
#define LIFTIQ_CAL_FAILED 3

// Everything one telemetry notification carries. Accelerations are m/s^2 (floats, scaled
// and saturated by the encoder); the rest are already integers.
struct TelemetryV1 {
  float ax;
  float ay;
  float az;
  float totalAccel;
  float dynamicAccel;
  uint16_t seq;               // wrapping sample sequence counter
  uint8_t phase;              // 0 idle, 1 concentric, 2 eccentric
  uint8_t calibrationStatus;  // LIFTIQ_CAL_*
  uint16_t repCount;          // wraps at 65536
  uint16_t batteryMillivolts; // 0 = unavailable
};

// m/s^2 -> int16 centi-units (x100), rounded to nearest, saturated at -32768..32767.
static inline int16_t liftiqScaleCenti(float value) {
  float scaled = value * 100.0f;
  if (scaled > 32767.0f) scaled = 32767.0f;
  if (scaled < -32768.0f) scaled = -32768.0f;
  return (int16_t)lroundf(scaled);
}

static inline void liftiqPutU16(uint8_t *out, uint16_t value) {
  out[0] = (uint8_t)(value & 0xFF);
  out[1] = (uint8_t)(value >> 8);
}

// 18-byte little-endian telemetry packet:
//   0-1 ax, 2-3 ay, 4-5 az, 6-7 total, 8-9 dynamic (int16 x100 m/s^2), 10-11 seq (u16),
//   12 phase, 13 calibration status, 14-15 reps (u16), 16-17 battery mV (u16, 0 = none).
static inline void encodeTelemetryV1(uint8_t out[LIFTIQ_TELEMETRY_V1_LENGTH], const TelemetryV1 &t) {
  liftiqPutU16(out + 0, (uint16_t)liftiqScaleCenti(t.ax));
  liftiqPutU16(out + 2, (uint16_t)liftiqScaleCenti(t.ay));
  liftiqPutU16(out + 4, (uint16_t)liftiqScaleCenti(t.az));
  liftiqPutU16(out + 6, (uint16_t)liftiqScaleCenti(t.totalAccel));
  liftiqPutU16(out + 8, (uint16_t)liftiqScaleCenti(t.dynamicAccel));
  liftiqPutU16(out + 10, t.seq);
  out[12] = t.phase;
  out[13] = t.calibrationStatus;
  liftiqPutU16(out + 14, t.repCount);
  liftiqPutU16(out + 16, t.batteryMillivolts);
}

// 20-byte INFO value: [protocolMajor u8][protocolMinor u8][capabilities u16 LE]
// [firmware string, NUL padded, max 16 chars; longer strings are truncated].
static inline void encodeInfoV1(uint8_t out[LIFTIQ_INFO_LENGTH], uint8_t protocolMajor,
                                uint8_t protocolMinor, uint16_t capabilities, const char *firmware) {
  memset(out, 0, LIFTIQ_INFO_LENGTH);
  out[0] = protocolMajor;
  out[1] = protocolMinor;
  liftiqPutU16(out + 2, capabilities);
  if (firmware) {
    size_t n = strlen(firmware);
    if (n > LIFTIQ_INFO_FW_MAX) n = LIFTIQ_INFO_FW_MAX;
    memcpy(out + 4, firmware, n);
  }
}

#endif  // LIFTIQ_PROTOCOL_V1_H
