# Bill of Materials

| Part | Description | Notes |
|---|---|---|
| Seeed Studio XIAO ESP32C3 | ESP32-C3, Wi-Fi + BLE | Current MCU; Arduino board target `XIAO_ESP32C3` |
| GY-BMI160 | 6-DOF accel + gyro breakout | I2C, confirmed at address 0x68 (SAO/SDO -> GND) |
| SSD1306 0.91" 128x32 | OLED display | I2C, shares bus with IMU |
| Battery | single-cell LiPo | Capacity/connector/charging TBD; optional voltage monitoring uses an external 2:1 divider |
| Button | TBD | set start/stop |
| LED | TBD | status indicator |

## Wiring / pinout

| Signal | XIAO ESP32C3 pin | GPIO |
|---|---|---|
| I2C SDA | D4 | GPIO6 |
| I2C SCL | D5 | GPIO7 |
| Battery monitor | D3 pad (divider midpoint), **jumpered to D1 = GPIO3 / ADC1_CH3** | D3/GPIO5 is ADC2 and cannot be read in software on the ESP32-C3; connect only through the specified divider |

### Battery monitor input

The current BLE firmware (`PIN_BATTERY = 3`) reads the divider midpoint on D1/GPIO3 (via the jumper below), averaging 16 samples, and reconstructs
the cell voltage using the configured 2:1 ratio. Use a 2:1 resistive divider
between LiPo positive and D3 (for example 47 kΩ from battery positive to D3,
and 47 kΩ from D3 to ground); add a 100 nF capacitor from D3 to ground to
reduce ADC noise. Battery negative, divider ground, and XIAO ground must be
common. With a single-cell LiPo this keeps the ADC input near or below 2.1 V at
full charge. **Never connect a LiPo cell directly to D3.**

**D3/GPIO5 cannot be read in software.** On the XIAO ESP32C3 D3 is GPIO5 = ADC2_CH0, and
the ESP-IDF in Arduino-ESP32 core 3.3.12 logs `adc_oneshot_new_unit: adc unit not
supported` (ESP_ERR_NOT_SUPPORTED) for ADC2, so both `analogReadMilliVolts` and
`analogRead` return 0 there, even though a multimeter shows 2.02 V on the pin (LiPo about
4.04 V through the 2:1 divider). The PCB therefore needs a jumper:

1. On the XIAO, check that D1 (GPIO3) is unused on the custom PCB (no net, nothing
   driving it).
2. Solder a short wire from the **D3 pad to the D1 pad**. D3 stays an unused,
   floating input (the firmware never configures or drives it).
3. The firmware reads D1/GPIO3 with `analogReadMilliVolts` (16-sample average). Without
   the jumper the pin reads 0 mV, the boot line prints a warning and the app shows
   "No battery". Confirm on the board which pad the wire is soldered to: the Serial boot
   line `[BATTERY] boot: pin D1/GPIO3=... mV` must read about half the cell voltage.

The boot line `[BATTERY] boot: ...` is always printed; the opt-in `DEBUG_DIAG 1` build adds
a `[DIAG]` line every 5 s that includes the battery millivolts.

Do not use D9 for this input on the XIAO ESP32C3: D9 is GPIO9, a boot-strapping
pin, and is not an ADC input. Verify the actual PCB net and divider with a
multimeter before connecting a battery. The existing Gerber export has not yet
been verified or revised for this C3 pin mapping; see
[`pcb/README.md`](pcb/README.md).

The app linearly estimates charge between 3.3 V (0%) and 4.2 V (100%) from the
reported cell voltage, not from a battery fuel-gauge IC. The estimate varies
with cell chemistry, load, temperature, and whether the cell is resting or
charging.

The XIAO ESP32C3 pin map uses D4/GPIO6 for SDA and D5/GPIO7 for SCL. The
current firmware explicitly initializes `Wire` with these pins. The BMI160
and SSD1306 share the I2C bus (different addresses, no conflict expected —
SSD1306 is typically 0x3C/0x3D). BMI160 confirmed at 0x68 via the boot-time
I2C scan (SAO/SDO strapped to GND on the existing board).

Firmware library: `DFRobot_BMI160` (Arduino Library Manager) — the
`hanyazou/BMI160-Arduino` library originally planned isn't in Library
Manager and wasn't pursued further once DFRobot's was confirmed working.
Note DFRobot_BMI160 hardcodes accel/gyro range to +/-2g / +/-2000dps
internally with no public setter to change it. The firmware therefore writes the
BMI160 ACC_RANGE (0x41) register itself after `I2cInit` (currently +/-8 g, 4096
LSB/g) and reads accelerometer data directly over I2C, because the library inserts
`delay(10)` plus `delay(1)` per byte in every read.

### GY-BMI160 breakout pins (all 12), per the Bosch datasheet's pin-out
table and I2C reference schematic (Figures 31/33, pages 101-102)

| Breakout pin | Chip pin | Required state |
|---|---|---|
| `SCL` | SCx | XIAO SCL (D5/GPIO7) |
| `SDA` | SDx | XIAO SDA (D4/GPIO6) |
| `GND` | GND/GNDIO | GND |
| `VIN` / `3V3` | VDD/VDDIO | 3.3V |
| `CS` | CSB | **tie to 3.3V** — selects I2C mode; floating is undefined behavior, not "don't care" |
| `SAO` | SDO | **tie to GND (0x68) or 3.3V (0x69)** — floating gives an unreliable address |
| `INT1`, `INT2` | INT1, INT2 | leave floating — datasheet: "if not used, DNC" |
| `SCX`, `SDX` | ASCx, ASDx (secondary/aux magnetometer interface, confusingly named) | leave floating — unused without an external magnetometer |
| `OCS` | OCSB (secondary OIS interface) | leave floating — unused |

Datasheet confirms `ASDX`/`ASCX`/`OCSB`/`OSDO` go high-impedance when
unused, so floating is the documented state, not a guess. CS and SAO are
the two pins worth double-checking with a multimeter if the boot-time I2C
scan doesn't find the device — some clone boards strap them onboard,
others leave them genuinely floating.

Button/LED GPIO assignment: TBD.

## Open questions

- Confirm the XIAO ESP32C3 battery connection/charging arrangement and verify
  the custom PCB's battery-divider net before assembly.
- Magnet mounting: strength/size needed to hold on a steel weight-stack
  plate without slipping mid-rep.
- Enclosure: 3D-printed vs off-the-shelf project box.
