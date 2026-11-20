// Host-side driver for the REAL firmware encoders (firmware/LiftIQ_BLE/protocol_v1.h).
// Reads one case per line on stdin and prints the encoded bytes as lowercase hex:
//   T <name> <ax> <ay> <az> <total> <dynamic> <seq> <phase> <calStatus> <reps> <batteryMv>
//   I <name> <major> <minor> <capabilities> <firmware string, rest of line>
// Output lines: "<name> <hex>" (36 hex chars for T, 40 for I). Used by tests/compat/firmware-encoder.test.js.
#include <stdio.h>
#include <stdlib.h>
#include "../../../firmware/LiftIQ_BLE/protocol_v1.h"

static void printHex(const char *name, const uint8_t *bytes, size_t length) {
  printf("%s ", name);
  for (size_t i = 0; i < length; i++) printf("%02x", bytes[i]);
  printf("\n");
}

int main() {
  char line[512];
  while (fgets(line, sizeof(line), stdin)) {
    char kind = 0;
    char name[128] = {0};
    if (sscanf(line, " %c %127s", &kind, name) != 2) continue;
    if (kind == 'T') {
      TelemetryV1 t;
      unsigned seq, phase, cal, reps, batt;
      if (sscanf(line, " T %*s %f %f %f %f %f %u %u %u %u %u", &t.ax, &t.ay, &t.az, &t.totalAccel,
                 &t.dynamicAccel, &seq, &phase, &cal, &reps, &batt) != 10) {
        fprintf(stderr, "bad telemetry line: %s", line);
        return 2;
      }
      t.seq = (uint16_t)seq;
      t.phase = (uint8_t)phase;
      t.calibrationStatus = (uint8_t)cal;
      t.repCount = (uint16_t)reps;
      t.batteryMillivolts = (uint16_t)batt;
      uint8_t out[LIFTIQ_TELEMETRY_V1_LENGTH];
      encodeTelemetryV1(out, t);
      printHex(name, out, sizeof(out));
    } else if (kind == 'I') {
      unsigned major, minor, caps;
      char fw[128] = {0};
      if (sscanf(line, " I %*s %u %u %u %127[^\r\n]", &major, &minor, &caps, fw) < 3) {
        fprintf(stderr, "bad info line: %s", line);
        return 2;
      }
      uint8_t out[LIFTIQ_INFO_LENGTH];
      encodeInfoV1(out, (uint8_t)major, (uint8_t)minor, (uint16_t)caps, fw);
      printHex(name, out, sizeof(out));
    }
  }
  return 0;
}
