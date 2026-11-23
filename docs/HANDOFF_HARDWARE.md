# Handoff: LiftIQ hardware discussion (for another AI assistant)

Status: reference
Last reviewed: 2026-11-23
Purpose: briefing written 2026-11-22 for the assistant discussing hardware v2 with the owner. Hardware paths inside it predate the reorganisation of `hardware/` (v1, v2, datasheets); the owner and that assistant own `hardware/`.

Written 2026-11-22 by the project's architect session. You have the same working copy of the repository. Read this file first,
then the files listed in section 8. The project owner ("the owner") will talk to you directly.

## 0. Your role and ground rules

- You are a hardware design advisor/engineer for the next hardware revision. Think, research, compare, and propose; the owner decides.
- Be honest about uncertainty. Several numbers in the docs were written from memory by earlier assistants — verify against
  datasheets before relying on them (the BMI160 datasheet is in `hardware/datasheets/`; others you must fetch or ask the owner for).
- Do NOT change firmware, the BLE protocol, the apps or tests unless the owner explicitly asks. Hardware proposals that need firmware
  changes must say exactly what changes and must keep the compatibility rules in `docs/PROTOCOL.md` (section 5 below).
- Do not commit, push, flash a board, or download/ install things without the owner's explicit OK. Other assistants are working in
  parallel on the apps (an openGym integration study, a workout/report UI) — stay out of `app/` and `tests/`.
- If you edit anything, edit only `hardware/` docs and `docs/HANDOFF_*`/hardware notes, and add a short entry to the change log in
  `docs/DEVELOPMENT.md` (see its "Rules" section).

## 1. The project in one paragraph

LiftIQ is a small Bluetooth LE sensor that clips (magnet-mounted) on the moving plate of **weight-stack cable machines** at the gym and
tracks reps and effort: it counts reps from vertical velocity pulses and derives peak velocity, velocity loss across a set, rep period, etc.
The sensor streams accelerometer data over BLE to a phone web app (Chrome/Android, Web Bluetooth). An integration into the open-source
openGym app is being studied. Prototype hardware is built and working; this discussion is about **what the next hardware version should be**.

## 2. Current hardware (v1 prototype, built and working)

| Item | Detail |
|---|---|
| MCU board | Seeed Studio XIAO ESP32-C3 (single-core RISC-V, BLE 5, Wi-Fi unused, USB-C, built-in LiPo charger). Arduino-ESP32 core 3.3.12 (NimBLE-based BLE) |
| IMU | GY-BMI160 breakout (Bosch BMI160: 3-axis accel + 3-axis gyro), I2C address 0x68 (SDO to GND), CS tied to 3V3. INT1/INT2 not connected. Configured: accel ±8 g, gyro ±1000 dps, 100 Hz live loop (50 Hz BLE notifications), 200 Hz in "raw capture" mode, I2C at 400 kHz |
| Battery | single-cell LiPo, 330 mAh, charged through the XIAO's USB-C charger. Capacity/connector details beyond that: ask the owner |
| Custom PCB | one prototype board carries the IMU breakout, the battery divider and the XIAO. Only the Gerber/drill export and a FlatCAM milling project are in the repo (`hardware/pcb/v1/`) — **no schematic/KiCad project is in the repo; ask the owner for it or for photos**. The Gerbers have never been verified against the XIAO footprint |
| Battery sense | 47 kΩ / 47 kΩ divider from LiPo+ with 100 nF to ground; midpoint read by the ADC (ratio 2:1) |
| Mounting | a magnet on the sensor holds it to the steel plate of the stack. Magnet size/strength/enclosure: **unknown, ask the owner** |
| Not present | power switch (unconfirmed — ask), fuel gauge, display (an SSD1306 and button/LED are listed in the BOM as TBD but no firmware uses them), wake-on-motion wiring, enclosure design |

### IMPORTANT correction about the battery-sense pin (docs are being fixed)
The divider midpoint was routed on the PCB to the **D3 pad = GPIO5**, which is on **ADC2 — unreadable on the ESP32-C3 with this core**
(`adc_oneshot_new_unit: adc unit not supported`; `analogRead` and `analogReadMilliVolts` return 0 although a multimeter shows 2.02 V).
The owner fixed it with a jumper wire to **GPIO4 (XIAO pad D2, ADC1_CH4)**; the committed firmware reads `PIN_BATTERY = 4`.
Several docs and a serial print still say "D1 / GPIO3" — that label is **wrong**, the firmware pin is GPIO4/D2 (a correction is in progress).
Verified on hardware: reading ≈ 2.03–2.08 V at the pin → cell 4.06–4.15 V. Confirm the actual solder pad with the owner.
XIAO ESP32-C3 pin map (from Seeed): D0=GPIO2, D1=GPIO3, D2=GPIO4, D3=GPIO5, D4=GPIO6 (SDA), D5=GPIO7 (SCL), D6=GPIO21, D7=GPIO20, D8=GPIO8, D9=GPIO9, D10=GPIO10.
ESP32-C3 facts to design around: ADC1 = GPIO0–4 (readable), ADC2 = GPIO5 (not readable here), deep-sleep GPIO wake = RTC GPIO0–5, strapping pins GPIO2, GPIO8, GPIO9.

## 3. Facts measured on the real prototype (evidence, not guesses)

- Live stream: loop exactly 100.0 Hz, BLE notifications 50.2 Hz, **no lost packets** (sequence counter), I2C read ≈ 271 µs avg (400 kHz OK, 0 errors).
- IMU register read-back OK: chip 0xD1, ACC_CONF 0x28 (100 Hz normal filter), ACC_RANGE ±8 g, gyro ±1000 dps. PMU 0x14 (accel+gyro normal).
- Real lifts reach ≈ 3 g (29 m/s²): ±2 g clipped, ±8 g is fine (no clipping seen).
- Resting accelerometer magnitude 10.11–10.16 m/s² (≈ +3 %): offset/scale error of this unit (BMI160 spec allows ±40 mg offset). A 6-position calibration tool exists (`tools/trajectory/calibrate_accel.py`) but has not been run.
- Gyro bias measured at rest: ≈ (0.43, −0.16, −0.14) °/s. In a hand rotation test the gyro-integrated tilt agreed with the accelerometer tilt within 0.7° at six rests; net drift < 1° over 16 s once the bias was subtracted.
- Raw capture: 200 Hz exactly, dt 5 ms. RAM is the limit: ~186 KB free heap at boot, ~120 KB with a BLE client connected → 40 s capture at ~12 B/sample.
- Battery: cell read 4.06–4.15 V (on USB charge). **Battery life has NOT been measured. Current draw has NOT been measured.**
- Real gym data: five seated-row sets (`data/recordings/app-sessions/`, figures per set in sub-folders): each rep is one fast up-pull of the plate
  (peak ≈ 0.5–1.0 m/s, 0.5–0.8 s, ≈ 30–37 cm stack travel — estimates) then a slow descent (≈ −0.3 m/s, ≈ 2 s); velocity loss across a set 13–29 %.
  The pulse counts were confirmed by the owner as ≈ 100 % correct (8, 8, 7, 5, 9 reps). Shocks of 30–38 m/s² occur when the handle is released.
- NOT yet measured: static noise/bias over time (Step 0 test A), a horizontal path with known geometry (test C), absolute accuracy of range of motion against a tape measure (tests D/E). Protocol: `docs/experiments/STEP0_PROTOCOL.md`.
  The decision gate from the architect: if the per-rep vertical range-of-motion error is ≲ 2 cm, the BMI160 is good enough; otherwise a better IMU is justified.

## 4. Lessons already learned (do not repeat these)

- ESP32-C3: never use GPIO5 (ADC2) for analog sensing; check strapping pins before assigning GPIOs.
- The DFRobot_BMI160 Arduino library adds `delay(10)` before every read and `delay(1)` per byte (≈ 22 ms per sample) and hard-codes ±2 g / 1600 Hz; the firmware now configures ACC_CONF/ACC_RANGE itself and reads accel bytes directly. Any new IMU needs a plan for its driver/library (maturity, timing, configuration blobs).
- A magnetometer does not fix position drift (it only gives heading); the sensor is magnet-mounted on steel equipment, so a compass would be disturbed. Gyro-bias calibration at rest keeps yaw drift negligible over a few seconds.
- Drift/accuracy of position-from-IMU is dominated by tilt error (≈ 1° ≈ 17 mg of fake acceleration) and accelerometer bias (5 mg ≈ 10 cm after 2 s) — so gyro quality, accelerometer bias stability and temperature drift matter more than noise density.

## 5. Software contract that constrains hardware changes

- The v1 BLE protocol is **frozen** (`docs/PROTOCOL.md`): service UUID, an 18-byte little-endian telemetry packet (accel ×100 m/s², sequence counter, phase, calibration status, firmware rep count, battery in mV where 0 = unavailable), commands 0x01 (calibrate) and 0x02 (thresholds), device name prefix `LiftIQ-XXXX`. Telemetry cadence is 50 Hz. The released phone app (`app/stable`) must keep working with any new firmware. New capabilities must be additive (new characteristics/commands), and are checked by `tests/compat`.
- The app's rep analysis needs ≈ 50 Hz vertical-acceleration data and a still second at the start of a set (gravity reference); it is rotation-invariant (mounting orientation is free) and written in `app/dev/analysis/`.
- Default BLE MTU is 23 (20-byte payload); notifications are batched by the phone's connection interval.
- Battery percentage in the app is a linear 3.3–4.2 V estimate; a fuel gauge would improve it.

## 6. Open hardware questions — what the owner wants help deciding

Priority order. For each, give options, trade-offs, a recommendation, and what must be measured first.

1. **Is the BMI160 good enough?** Define the minimum measurement plan (which Step 0 tests, in what order, what numbers decide) and what a "no" would change.
2. **IMU alternatives** (owner's preference: IMUs only, possibly a magnetometer; no barometer/ToF/camera): BMI270, BMI323, ICM-42688-P, ICM-45686, LSM6DSV16X, BMI160 successors. Criteria: accelerometer bias/temperature stability, gyro bias stability and range, noise, FIFO/wake-on-motion/interrupts, driver and library maturity for ESP32-C3 (Arduino/ESP-IDF), breakout availability or hand-solderable packages (the "Tiny Open Logger" paper — `docs/references/` — rejected BGA parts and chose BMI270 + MLX90393), price, supply. The BMI270 needs an ≈ 8 KB configuration blob uploaded at every power-up.
3. **Magnetometer — yes or no?** The owner is open to one. Evaluate honestly given magnet mounting + steel plates (what would it add? what would it break?). Suggest a cheap way to measure the magnetic environment at the plate before spending anything.
4. **Power:** measure or estimate current in (a) BLE streaming, (b) idle/advertising, (c) deep sleep; propose a sleep strategy (wake-on-motion needs the IMU interrupt wired to an RTC GPIO 0–5), a power switch or auto-off, a battery size decision (330 mAh now), charging behaviour, low-battery cut-off, and whether a fuel gauge (e.g. MAX17048 on I2C) is worth it. Target use: a gym session of 1–2 h plus idle days.
5. **v2 pin plan for the XIAO ESP32-C3:** a full table (I2C, IMU INT1/INT2, battery sense on ADC1, LED, button, spare) respecting strapping pins, ADC1/RTC constraints and the owner's existing board habits. Keep the battery sense off GPIO5.
6. **Mechanical:** magnet type/size/strength for steel plates under vibration and the "clank" when the stack lands, enclosure (3D-printed), sensor placement/orientation marking, USB-C access for charging, sweat/dust, impact survival, thermal self-heating (accelerometer temperature drift).
7. **Manufacturing path:** DIY-milled board (FlatCAM project exists) vs fab service; reuse or adapt the open TOL expansion board (XIAO + BMI270 + MLX90393 + NAND flash, `github.com/ThumusWasTaken/XiaoMoCap`) vs own design; schematic/KiCad capture (none exists in the repo).
8. **Optional later:** a different MCU (e.g. an nRF52840-based board with lower BLE power) — only if power numbers show the ESP32-C3 cannot meet the battery target; the owner currently wants to keep the ESP32-C3 and the LiPo.

## 7. Owner's constraints and preferences

- Keep the XIAO ESP32-C3 and a LiPo for the next version unless evidence says otherwise.
- IMU-only sensing (+ possibly a magnetometer). No barometer, no time-of-flight, no camera.
- Cable weight-stack machines first (vertical plate motion). Free-weight bars are a later question.
- Hobby/DIY friendly: hand-solderable parts, open tools, low cost. The owner already built a first board by hand.
- Existing hardware keeps working; changes must not break the released app (section 5).

## 8. Repository map (read these)

| Path | Why |
|---|---|
| `hardware/BOM.md`, `hardware/pcb/README.md`, `hardware/pcb/v1/`, `hardware/datasheets/IMU BMI160.pdf` | the hardware as documented (note the pin-label correction in section 2) |
| `firmware/LiftIQ_BLE/LiftIQ_BLE.ino`, `firmware/LiftIQ_BLE/protocol_v1.h` | pins, IMU configuration, timing, battery read, raw capture |
| `docs/PROTOCOL.md`, `docs/ARCHITECTURE.md`, `docs/DEVELOPMENT.md` | contract, structure, the tracker with every decision and measured result |
| `docs/REP_ANALYSIS.md`, `app/dev/analysis/` | what the signal processing needs from the hardware |
| `docs/experiments/STEP0_PROTOCOL.md`, `tools/trajectory/` | the measurement plan and offline analysis tools (fusion, zero-velocity updates, sensitivity/Monte-Carlo with a BMI160-like and a BMI270-like error model) |
| `data/recordings/`, `tests/fixtures/seated-row-2026-11-22/` | real data (live gym sets, a raw 200 Hz capture) |
| `docs/references/` | the Tiny Open Logger paper (BMI270 + magnetometer on an XIAO) |

Useful commands (ask before running anything that downloads or flashes): `cd app && npm run test:all`; firmware compile
`arduino-cli compile --fqbn esp32:esp32:XIAO_ESP32C3 --warnings all firmware/LiftIQ_BLE`.

## 9. What a good answer from you looks like

1. Start by asking the owner for what is missing (schematic or photos of the board, magnet and enclosure details, battery connector, whether there is a power switch, how long a charge currently lasts, what they plan to measure next).
2. Then deliver, step by step with the owner: a measurement plan, a v2 block diagram, a pin map, a BOM with two options per critical part and the reasoning, a power budget, a mechanical sketch/requirements list, and a risk list — each marked verified / estimated / unknown.
3. Keep the owner in control: recommendations with trade-offs, not decisions. Record agreed conclusions in a short note (e.g. `hardware/V2_DECISIONS.md`) and a row in the tracker only when the owner says so.
