# LiftIQ documentation index

Status: current
Last reviewed: 2026-11-23
Purpose: one line per document with a status tag, and the order to read them in.

Status tags: **current** (maintained, trust it) · **reference** (accurate for what it describes, but that part is no longer the direction) ·
**historical** (a record of what was known or done at the time) · **superseded** (replaced by another document; kept so nothing is lost).
Every document under `docs/` starts with a `Status:` header. Run `node tools/check-links.mjs` (part of `npm run test:all`) after moving files.

## Start here

**New contributor**
1. [`../README.md`](../README.md) - what LiftIQ is, quick start, where things are.
2. [`DEVELOPMENT.md`](DEVELOPMENT.md) - rules, status board, open decisions, next steps.
3. [`ARCHITECTURE.md`](ARCHITECTURE.md) - components, data flow, release model, folder map.
4. [`PROTOCOL.md`](PROTOCOL.md) - the frozen BLE contract (read before touching firmware or the decoder).
5. [`OPENGYM_INTEGRATION_DESIGN.md`](OPENGYM_INTEGRATION_DESIGN.md) - where the product is going.
6. Then what you work on: [`REP_ANALYSIS.md`](REP_ANALYSIS.md) (analysis), [`../packages/liftiq-sensor/README.md`](../packages/liftiq-sensor/README.md) (sensor code), [`../app/README.md`](../app/README.md) (apps, release), [`../tools/README.md`](../tools/README.md) (PC tools).

**AI assistant (read in this order, then act)**
1. [`DEVELOPMENT.md`](DEVELOPMENT.md) - Rules and Fixed constraints are binding; the status board says what is owned by whom (do not touch `hardware/`, `app/stable/`, golden vectors, fixtures or recordings without being asked).
2. [`ARCHITECTURE.md`](ARCHITECTURE.md) (folder map, vendoring: sensor code is edited only in `packages/liftiq-sensor/src`) and [`PROTOCOL.md`](PROTOCOL.md).
3. The document for your task (table below). Treat `reference`, `historical` and `superseded` documents as background, not as instructions.
4. Before finishing: `cd app && npm run test:all`, then update the status board / Next steps and append to [`../CHANGELOG.md`](../CHANGELOG.md). Never commit unless asked.
5. Looking for why something is the way it is: [`history/DEVELOPMENT_HISTORY.md`](history/DEVELOPMENT_HISTORY.md) (long decision notes with measured results).

## All documents

| Document | Status | What it is |
|---|---|---|
| [`DEVELOPMENT.md`](DEVELOPMENT.md) | current | Short living tracker: fixed constraints, rules, status board, open decisions, known issues, next steps |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | current | Components, data flow, stable/dev release model, sensor-package vendoring, compat gates, folder map |
| [`PROTOCOL.md`](PROTOCOL.md) | current | BLE protocol v1 (frozen), behavioural guarantees, extension rules |
| [`REP_ANALYSIS.md`](REP_ANALYSIS.md) | current | Spec of the pulse/rep analysis (offline and live); code in `packages/liftiq-sensor` |
| [`OPENGYM_INTEGRATION_DESIGN.md`](OPENGYM_INTEGRATION_DESIGN.md) | current | Study and design of the sensor inside the openGym fork; milestones P0-P6, owner decisions |
| [`experiments/STEP0_PROTOCOL.md`](experiments/STEP0_PROTOCOL.md) | current | Physical experiment protocol for raw captures (IMU decision gate, experiments A-E) |
| [`RELEASE_1_1_0.md`](RELEASE_1_1_0.md) | current | what stable 1.1.0 contains, owner steps (release, commit, push, checks, rollback), risks |
| [`UX_TRAIN_FLOW.md`](UX_TRAIN_FLOW.md) | reference | UX contract of the dev app's Train flow; superseded by the openGym UI, kept for the logic it exercises |
| [`EXERCISE_DATA.md`](EXERCISE_DATA.md) | reference | Open exercise dataset, runtime media links, media-licence status (clarification pending) |
| [`IMAGE_CREDITS.md`](IMAGE_CREDITS.md) | reference | Credits of the default machine photos in the dev app |
| [`HANDOFF_HARDWARE.md`](HANDOFF_HARDWARE.md) | reference | Briefing for the hardware-v2 assistant (hardware is owned by the owner; paths predate the `hardware/` reorganisation) |
| [`INTEGRATION_OPENGYM.md`](INTEGRATION_OPENGYM.md) | historical | First openGym research notes and phases P1-P4; research input to the design above |
| [`history/DEVELOPMENT_HISTORY.md`](history/DEVELOPMENT_HISTORY.md) | historical | Per-batch notes (Batch 1 to 2c, Step 0, repo structure, workout-flow W-series, ideas) moved verbatim from the old tracker |
| [`../CHANGELOG.md`](../CHANGELOG.md) | historical | Dated change-log entries (files touched, verified, not verified); new entries are appended |
| [`references/README.md`](references/README.md) | reference | Third-party papers kept for the project (Tiny Open Logger) |

Documents outside `docs/` worth knowing: [`../NOTICE.md`](../NOTICE.md) (licences of third-party parts), [`../hardware/BOM.md`](../hardware/BOM.md) (hardware is being reorganised by the owner),
[`../tests/fixtures/README.md`](../tests/fixtures/README.md), [`../data/recordings/README.md`](../data/recordings/README.md), [`../firmware/archive/README.md`](../firmware/archive/README.md),
[`../tools/trajectory/README.md`](../tools/trajectory/README.md).

## Superseded content (kept, not deleted)

- The dev app's Train flow, exercise picker, photos and history (documented in [`UX_TRAIN_FLOW.md`](UX_TRAIN_FLOW.md), [`EXERCISE_DATA.md`](EXERCISE_DATA.md), [`IMAGE_CREDITS.md`](IMAGE_CREDITS.md) and the Train-flow part of [`../app/README.md`](../app/README.md)) is superseded by the openGym integration.
- Phases P1-P4 in [`INTEGRATION_OPENGYM.md`](INTEGRATION_OPENGYM.md) are superseded by the milestones in the design document.
- The pre-2026-11-23 long form of `DEVELOPMENT.md` is split into [`history/DEVELOPMENT_HISTORY.md`](history/DEVELOPMENT_HISTORY.md) and [`../CHANGELOG.md`](../CHANGELOG.md).
