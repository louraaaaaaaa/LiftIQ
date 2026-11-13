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
| Battery monitor | D1 | GPIO3 / ADC1_CH3; connect only through the specified divider |

### Battery monitor input

The current BLE firmware reads battery voltage on D1/GPIO3/ADC1_CH3. Use a
2:1 resistive divider between LiPo positive and D1 (for example 47 kΩ from
battery positive to D1, and 47 kΩ from D1 to ground); add a 100 nF capacitor
from D1 to ground to reduce ADC noise. Battery negative, divider ground, and
XIAO ground must be common. With a single-cell LiPo this keeps the ADC input
near or below 2.1 V at full charge. **Never connect a LiPo cell directly to
D1.**

Do not use D9 for this input on the XIAO ESP32C3: D9 is GPIO9, a boot-strapping
pin, and is not an ADC input. Verify the actual PCB net and divider with a
multimeter before connecting a battery. The existing Gerber export has not yet
been verified or revised for this C3 pin mapping; see
[`manufacturing/README.md`](manufacturing/README.md).

The app estimates charge from the reported voltage, not from a battery
fuel-gauge IC. The estimate varies with cell chemistry, load, temperature, and
whether the cell is resting or charging.

The XIAO ESP32C3 pin map uses D4/GPIO6 for SDA and D5/GPIO7 for SCL. The
current firmware explicitly initializes `Wire` with these pins. The BMI160
and SSD1306 share the I2C bus (different addresses, no conflict expected —
SSD1306 is typically 0x3C/0x3D). BMI160 confirmed at 0x68 via the boot-time
I2C scan (SAO/SDO strapped to GND on the existing board).

Firmware library: `DFRobot_BMI160` (Arduino Library Manager) — the
`hanyazou/BMI160-Arduino` library originally planned isn't in Library
Manager and wasn't pursued further once DFRobot's was confirmed working.
Note DFRobot_BMI160 hardcodes accel/gyro range to +/-2g / +/-2000dps
internally with no public setter to change it.

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
