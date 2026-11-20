# PCB v1 (prototype board)

> **WARNING - not yet verified.** The exported Gerber/drill files in `v1/gerbers/` have **not** been
> checked against the XIAO ESP32C3 footprint and the battery-sense net. In particular the battery
> divider midpoint is routed to the D3 pad (GPIO5 = ADC2), which the ESP32-C3 cannot read in software;
> the working prototype needs a jumper wire from the D3 pad to the D1 pad (GPIO3 = ADC1), see
> [`../BOM.md`](../BOM.md) and `docs/DEVELOPMENT.md` (Batch 2b). Review the footprint, the battery
> net and the power path with a multimeter before ordering more boards or assembling anything, and
> never connect a LiPo cell directly to a GPIO.

## Contents

| Path | What |
|---|---|
| `v1/gerbers/liftiq-pcb-unversioned-export/` | Gerber + drill export (`Gerber_*.G*`, `Drill_*.DRL`) and `How-to-order-PCB.txt`. The export was never version-tagged ("unversioned"); the files are byte-identical to what was committed before the repository reorganisation (only the folder name changed: it used to be `LiftIQ PCB` with a space) |
| `v1/flatcam/LiftIQ.FlatPrj` | FlatCAM project for milling the board |

History: these files used to live in `hardware/manufacturing/`; that folder's README was referenced
but never existed. This file is the intended target of those links.
