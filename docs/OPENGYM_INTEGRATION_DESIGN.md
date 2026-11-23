# LiftIQ x openGym: feasibility study and integration design

Status: current
Last reviewed: 2026-11-23
Purpose: feasibility study and design for integrating the LiftIQ sensor into the openGym fork (`github.com/louraaaaaaaa/openGym`, branch `liftiq`). Builds on the earlier research notes [`INTEGRATION_OPENGYM.md`](INTEGRATION_OPENGYM.md). P0 (fork + standalone build) is done and pushed, P1 (spike) is next; see the status board in [`DEVELOPMENT.md`](DEVELOPMENT.md).

Study status as written on 2026-11-22: study done, no code written, nothing forked yet (since then: fork created, P0 done and pushed, see the header above). Builds on [`INTEGRATION_OPENGYM.md`](INTEGRATION_OPENGYM.md) (phases P1-P4 there; this
document is the detailed design of P4, "deep integration").

Method: a sparse, shallow clone of `https://github.com/DuarteSantos8/openGym` (HEAD of `main` on 2026-11-22, frontend version 1.4.5) was
read in the scratchpad (not in this repo): `CLAUDE.md`, `CONTRIBUTING.md`, `NOTICE.md`, `CLA.md`, `docs/`, `frontend/src`,
`frontend/package.json`, `frontend/vite.config.js`, `api/server.js` and `api/sync-stamps.js`, plus single files read from git
(`web/Dockerfile`, `web/nginx.conf.template`, `frontend/public/sw.js`, `.github/workflows/*`, `AndroidManifest.xml`, `Info.plist`).
The catalogue, media and native folders were not downloaded (`NOTICE.md` forbids feeding the media to AI tools; nothing from
`catalogue/media` was fetched). Fetched content is treated as data. Nothing was built or run: `npm install`, `vite build`, vitest and a
real Web Bluetooth test were NOT done. Everything below is "read in source" unless marked **UNVERIFIED**.

Paths below are relative to the openGym repo unless they start with `app/`, `docs/`, `firmware/` (LiftIQ).

---

## A. Findings per question

### A1. Run modes, demo build, persistence, Web Bluetooth

- **Static, phone-only web app is already a supported build: the demo.** `.github/workflows/pages.yml` builds with `VITE_DEMO=1 npm run build`
  (working dir `frontend`, Node 26) and publishes to GitHub Pages (`duartesantos8.github.io/openGym/`); the same build is served at
  `opengym.ch/demo/`. `frontend/src/lib/demo.js`: no api, no passkey login, no sync, no admin; the app stays in guest mode (everything in
  `localStorage`) and on first boot seeds an example history (`demoSeed.js`, flag `gym_demo_seeded_v1`, `store/useStore.js` ~l.2242).
  The 180 px media are staged next to the build by `scripts/catalogue/stage-media.mjs frontend/dist` (needs `catalogue/media`, so the
  fork repo must carry it; allowed for a non-commercial fork, see A6/D).
- **Vite base is `./`**, so any sub-path hosting works (GitHub Pages project page). Service worker `frontend/public/sw.js` is stamped at build
  time by `vite.config.js` (`__BUILD__`, `__LAZY__`); offline shell + media cache (cap 150 MB).
- **Env flags** (build time): `VITE_DEMO=1` (static/guest/seed), `VITE_MOBILE=1` (Capacitor flavour, `lib/mobile.js`), `VITE_IMG_BASE`,
  `VITE_GIF_BASE`, `VITE_CLIP_EXT`, `VITE_BUILTIN_CLIP_PX`, `VITE_APK_VARIANT`, `VITE_UMAMI_SRC/ID` (opt-in analytics, off by default),
  `VITE_SEASON_CLOCK`, `APP_BUILD`. Dev: `API_TARGET`, `API_ORIGIN`, `MEDIA_TARGET`.
- **What the demo drops:** account/passkeys, server sync, WebDAV backup, push (server Web Push), Coach (stub `coach-demo.js`), webhooks/MCP,
  API tokens, Community, admin. Settings code branches on `DEMO` in ~15 places (Settings.jsx, ServerSync.jsx, Modules.jsx, Integrations.jsx).
  Core logging, plans, history, stats, imports, CSV export, backups to file, performance report (print/PDF in the browser) remain.
- **Non-demo web build without api** is not a mode: it shows the login/guest flow and expects `/api`. For us a fork would use the demo flavour,
  ideally renamed/neutralised (a `VITE_STANDALONE=1` alias that keeps `DEMO` behaviour but skips the demo seed and the "Demo" labels).
  That is a small patch in `demo.js`/`useStore.js`/`Settings.jsx` copy (**decision D3**).
- **Persistence:** whole profile = one object `S`, Zustand store `store/useStore.js`, persisted to `localStorage` key `gym_state_v1`
  (plus bookkeeping keys: `gym_owner`, wid/dirty/sync keys). On the phone shells also mirrored to a file (`lib/mobile.js` `nativeSave`)
  because WebView storage can be evicted. Media (photos/videos) use their own store (backup-media.js; IndexedDB/files, not read in detail).
  Consequence for a PWA on a phone: localStorage can be evicted by the browser under pressure unless the PWA is installed or storage is
  "persisted"; openGym has backup-to-file and CSV export as mitigation. Quota is ~5-10 MB per origin: per-set raw sensor traces must NOT go
  into `S` (see A2/B).
- **Web Bluetooth feasibility in this PWA: yes, on Android Chrome (and desktop Chrome/Edge), no on iOS Safari.**
  - Secure context: GitHub Pages/https and `localhost` are secure contexts. No `navigator.bluetooth` use exists in openGym today
    (grep found only Garmin/BT text in docs).
  - CSP: only the self-hosted nginx image sets a CSP (`web/Dockerfile` ENV `CONTENT_SECURITY_POLICY`): `default-src 'self'; script-src 'self'
    'sha256-<index.html inline script>'; style-src 'self' 'unsafe-inline'; connect-src 'self' https: http:; worker-src 'self'...`. CSP has no
    directive that governs Web Bluetooth. Our module would ship as bundled same-origin JS, so `script-src 'self'` is fine; no inline script,
    no eval, no extra origin needed. A CSP test (`lib/csp.test.js`) pins the inline-script hash: do not touch `index.html`'s inline script.
  - `Permissions-Policy`: `web/nginx.conf.template` sets only X-Frame-Options, X-Content-Type-Options, Referrer-Policy and CSP (grep for
    "permissions-policy|bluetooth" found nothing), so the default (bluetooth allowed in top-level documents) applies. GitHub Pages sets no
    such header either.
  - Service worker: a SW does not intercept GATT; it only matters that `sw.js` keeps serving the app shell offline. `requestDevice()` needs a
    user gesture and shows Chrome's chooser each session unless `getDevices()` permission persistence is available (Chrome flag-dependent;
    LiftIQ already handles reconnect, see `app/dev/ble.js`).
  - Screen Wake Lock during a set: LiftIQ already uses it (`app/dev/wakelock.js`); openGym has its own wake logic (not read).
  - Risk (**UNVERIFIED**): Chrome may throttle/suspend BLE notifications when the page is backgrounded or the screen is off; LiftIQ's
    approach (wake lock during a set) carries over.

### A2. Data model

- **Workout (finished)** is built by `lib/finish-workout.js` `buildCompletedWorkout`: `{ id, d, start, end, routineIds, routineId, name, bw,
  entries[], prs[], note?, circuits?, gym?, excludeFromProgression? }`. Stored in `S.workouts`. An in-progress session lives in `S.active`
  (same shape plus `cur`, pause info), device-local (the api deletes `state.active` in `commitState`).
- **Entry (exercise slot):** `{ id (catalogue exercise id), sets[], topW, target, rid?, noProg?, planned?, sg? (superset group), brand?,
  muscleSnapshot?, note?, notePin? }`. Exercise ids are catalogue ids as strings (`"0025"` = barbell bench press in `docs/INTEGRATIONS.md`),
  plus user-defined custom exercises (`S.customEx`). The built-in ids come from the ExerciseDB family; LiftIQ's own index
  (hasaneyldrm dataset, `docs/EXERCISE_DATA.md`) uses the same lineage, so a large part of an id mapping is probably identity
  (**UNVERIFIED**; openGym added ~4,300 own entries since).
- **Set (row):** plain object; fields found in code: `w` (weight, state unit kg/lb), `r` (reps), `done` (bool), `at` (ms, stamped when
  ticked, used for session end), `rir` | `rpe` (effort, mutually exclusive in practice), `phase` ('work'|'warmup') or legacy `warmup`,
  `type` ('straight'|'dropset'|'restpause'), `drops[{w,r}]`, `clusters[{r,restSec}]`, `cluster`, `failure`, `sides:{L,R}` (per-side sets,
  each with its own w/r/done), `sec`, `min`, `km`, `dist`, `speed`, `planSec`, `note`, `tempo`, `bands`, `tag`, video ref, `restSec`
  (session-only), `weightOrigin` (session-only), and the **sensor-like precedent `hr: {avg,max}` and `restHr: {avg,max}`**. There is no
  per-set id: a set is addressed by (workout id, entry index, set index). Live-only keys are removed by `finishedRow()`; everything else is
  kept ("Only what was logged").
- **Where sets are created/edited:** `views/Workout.jsx` (2,946 lines): per-exercise card renders rows (`plainRow`, ~l.900; per-side rows
  ~l.1040; sub-rows for drops/bursts). Cell edits go through `onField(i, field, value)`; the set number button opens `openSetMenu`
  (l.708) built with `menuSheet` (sheets.jsx), an item list of `{icon,label,sub,onClick}`; ticking uses `toggle(idx,i,side)` (l.2226).
  Warm-ups are generated by `lib/warmup-ramp.js`.
- **Ticking a set = the integration point.** `toggle()` sets `done`, stamps `at`, then computes the rest (`restSecFor`, set's own rest,
  warm-up rest, transition rest) and calls `startRest(sec, idx, {forSet, rest})` in `store/useUI.js` (l.374; `stopRest` l.524, pause/resume
  and a native rest notification path exist). Records, PR cheer, progression and superset navigation all hang off the same `toggle`.
  So the sensor flow must set `w`/`r` through the store (`onField`) and then call the existing tick, never re-implement it.
- **Finish:** `doFinishWorkout` -> `buildCompletedWorkout(active, {end, prs, snapshotFor, brandFor})`; whitelisting happens at ENTRY level
  (`id, sets, topW, target, rid, noProg, planned, sg, brand, muscleSnapshot, note, notePin`), NOT at set level: sets are copied as-is by
  `finishedRow` (which strips only `planSec`, `weightOrigin`, `restSec`). An unknown key on a set therefore survives finish. Note
  `sessionEnd()` uses `at` of sets and `rowLengthMs` (`min`, `sec`): leave those alone.
- **Do extra per-set fields survive? Mostly yes, verified by reading, not by running:**
  - `lib/sync-merge.js`: workouts are merged by id; for an id both sides have, the version edited last wins, sets/entries taken whole
    (header comment; `mergeEntry` with `_f` stamps for field-level). No set-level whitelist found.
  - `api/sync-stamps.js` (only if an api is used): a `V139_DROPS` map lists keys an *old non-stamping app* may legitimately drop; any other
    key missing from the incoming set is put back from the stored copy (`keepKeys`). So unknown set keys survive in both directions.
    `PUT /api/data` validates only that `state` is an object and `workouts/routines` are lists (`records()` drops non-object items), plus a
    5 MB body limit (`nginx client_max_body_size 5m`, `MAX_BODY`). **Size is the real constraint.**
  - Export CSV (`lib/export-csv.js`, `WORKOUT_COLUMNS` fixed: date ... set_color) and the CSV/Strong/Hevy importers are column-based, so
    extra fields are NOT exported and not re-imported (a CSV round trip loses them). JSON backup is the whole state, so it keeps them
    (`lib/backup-sane.js` `dropBrokenRows` only drops broken rows; **UNVERIFIED** that no restore path re-whitelists set keys, check
    `store/backup-roundtrip.property.test.jsx`).
  - Therefore: attach small derived metrics on the set (`set.vbt = {...}`), keep raw traces elsewhere.
- **Closest precedent, heart rate per set** (`lib/heart-rate.js`, `lib/health-read.js`, `lib/health-sync.js`): after a workout is finished,
  samples from Health Connect/Apple Health ([ms, bpm]) are read, `hrFromSamples(w, samples)` estimates each set's time window from its tick
  `at` and its length, and `mergeHeartRate(S, wid, samples, src)` writes `set.hr = {avg,max}` / `set.restHr`, `w.hr = {..., src, n}`, never
  overwriting a reading that exists (the Apple Watch measures live) and calls `stampWorkout(w, now)` so sync keeps the edit. `sanitizeHr`
  validates (25..250 bpm); `hrLabel` renders " ♥ 132/151" after the set label; `lacksHeartRate` decides what to fill. A live heart rate
  (`components/LiveHeartRate.jsx`, `LiveCard.jsx`) is shown during the workout. Form videos (module `videos`, `setVideoOf`) are a second
  per-set attachment precedent. Our `vbt` field should copy this pattern: a sanitiser, a one-line label, `stampWorkout` after editing a
  finished workout, and "never overwrite what is there".

### A3. Extension points

- **Modules** (`lib/modules.js`, 135 lines; `views/Modules.jsx`; `docs/MODULES.md` "A new module"): add an object to `MODULES`
  `{id,group,icon,tint,title,desc}`, put it into presets (`TRAINING`/`PRESETS`), add its words to `lib/modules-copy.js` (inside `t()`), add
  `MODULE_KW` search words, and gate surfaces with `isOn(S,'liftiq')`. `S.modules` is per-key in `sync-merge.js PER_KEY` and
  `api/sync-stamps.js`; a *new* module id needs no sync change (unknown id = on; the map is per key), but an api server may need nothing.
  `build-caps.js` can mark a module unavailable per build (used for Offline). Modules are first-party only ("Nothing outside the app can
  add code"): a LiftIQ module means a fork or an upstream-accepted PR. **No dynamic plugin loading exists**.
- **Per-set action:** best fit is an item at the top of `openSetMenu`'s first section (`Workout.jsx` l.708-740, e.g. `{icon:'bolt',
  label:t('Record with sensor'), onClick: () => liftiqSheet(...)}`, gated with `isOn`), plus optionally a small button in `plainRow` next
  to the check (like the existing `setgo` play button for timed sets, l.912).
- **Sheets:** `sheets.jsx` (4,864 lines) holds `menuSheet`, `confirmSheet`, `effortPickerSheet`, etc.; CLAUDE.md says "a new sheet can go
  into `components/` as its own file" and the sheet host is `useUI.getState().openSheet(render)`. So `components/LiftiqSetSheet.jsx`
  (live count, stop, review) is the right place; no change to sheets.jsx except an import if we reuse helpers.
- **Settings/Integrations:** `views/settings-pages.js` has `PAGES` (id -> title/icon/tint/`mod`/`parent`/`kw`) and `SEARCH` rows;
  `views/Settings.jsx` renders pages; `views/Integrations.jsx` + `lib/integrations.js` `directory()` render cards (`CARD`, `WORKS_WITH`).
  A "LiftIQ sensor" page (connect, battery, firmware, forget device, calibration/ready-check, units) fits as a `PAGES` entry under
  `parent:'integrations'` with `mod:'liftiq'`, plus a card in the directory. Exact render hook in Settings.jsx not traced
  (**UNVERIFIED**; expect ~10 lines).
- **Stats:** `views/Stats.jsx` is gated section by section with `isOn` (l.608 `const on = id => isOn(S,id)`) and has a per-exercise
  chart view; a "Bar speed" section/card can read `set.vbt` from `S.workouts`.
- **Performance report PDF:** `components/ReportSheet.jsx` -> `lib/report-print.js` (538 lines): builds an HTML document with
  self-made SVG helpers (`barChartSVG`, `lineChartSVG`, `calendarSVG`) and prints it in the browser (`printReport`, `workoutPrintHTML`,
  `reportPrintHTML`); `lib/print-doc.js`; CI sample renderer `npm run pdf:check` (`scripts/pdf/render-samples.mjs`, A4/Letter, en/de/ar).
  A sensor section is therefore additive HTML+SVG: our framework-free SVG builders can be called from a new function appended in
  `reportPrintHTML` / `workoutPrintHTML` behind `isOn(S,'liftiq')` (~15 lines in report-print.js). Feasible; needs new `t()` strings.

### A4. Repo rules that affect us

- **Dependency-light is a hard constraint** (CLAUDE.md, CONTRIBUTING.md): frontend = React, Router, Zustand + Capacitor plugins; "a new
  dependency is a hard sell". A BLE client in our own code (Web Bluetooth) adds no dependency; `@capacitor-community/bluetooth-le` later
  would be one (fine in a fork, a hard sell upstream).
- **Style:** no linter, no TypeScript, match surrounding style by hand; comments for the *why*; user-facing text plain, no em dashes.
  "Training logic gets a unit test": anything that decides what you lift next or reads a logged session back is a pure helper in
  `src/lib` with a `*.test.js` beside it (our analysis modules qualify and are already pure). "Click through what you touched in a
  browser". Leave CHANGELOG.md alone.
- **i18n:** English is the source language and has **no locale file**; the key IS the English string in `t('...')`. There are **25
  locale packs** in `frontend/src/locales/`: ar bn cs da de es fa fr hi hu id it ko lt pl pt-BR pt ru sv th tr uk vi zh-TW zh (`de.js`
  alone is 5,920 lines; de-CH is derived). `node scripts/check-locales.mjs` (CI) compares packs to each other: a key present in some and
  missing/blank in others, or with a lost `{n}` placeholder, fails. `node scripts/check-source-strings.mjs --strict` (CI) fails if a literal
  `t('...')` is defined in no pack. Net effect: **every new UI string must be added to all 25 packs** (pt-BR inherits from pt; a fingerprint
  test `scripts/pt-br-inheritance-fingerprint.mjs` needs an override or an "accepted as shared" entry). There is NO automatic fallback
  *check*: at runtime a missing key silently shows English, but CI blocks it. No machine-translation workflow in the repo (NOTICE.md says
  pt-BR exercise text was produced with Codex/Claude assistance, so AI-assisted translation is accepted practice). For us: keep the module's
  string count small (target < 80 keys) and generate packs with a script plus review.
- **Tests:** vitest (+ happy-dom/linkedom/fast-check) in `frontend` (`npm test`, then `check:native-localizations`), `node --test` in api/mcp.
  Very large suite: roughly 1,500 files under `frontend/src` in the sparse tree, hundreds of `*.test.jsx`. Per-view tests exist for Workout
  (many `Workout.*.test.jsx`), so a Workout.jsx patch can break tests that use snapshots of the set menu: run the whole suite.
- **Versions:** CLAUDE.md says Node 22; `test.yml`, `pages.yml` and Dockerfiles use Node 26 (inconsistency in their docs; use 26 to match CI).
  Vite 8, React 19.3, vitest 4. Build `target: safari15, chrome100, firefox100, edge100`. `chunkSizeWarningLimit 1500`. `scripts/check-bundle-syntax.mjs`
  rejects syntax newer than the targets (our code must not use newer syntax).
- **Build time and bundle size: UNVERIFIED** (no install done). Locale packs, instr and exercise-name packs are lazy chunks; English-only
  in the main bundle.
- **Media rule** (CLAUDE.md "Exercise media"): only 180 px files in the repo/CI/demo; larger sizes only inside store packages built on the
  release machine; never feed media to an AI tool. This applies to our agents working in the fork: exclude `catalogue/media` from any tool call
  that reads files (a sparse clone without it is enough).
- **Governance:** GitHub is home (`.github/workflows/mirror.yml` mirrors to GitLab, fast-forward only). PRs need the CLA bot comment
  (`cla.yml`); first-time contributor workflows wait for maintainer approval; iOS CI needs a maintainer to start it. Contact channels: Discord,
  GitHub Discussions "Ideas".

### A5. Native BLE

- **Capacitor 8** (`@capacitor/core ^8.5.3`, `android`/`ios`/`cli`), plugins in `frontend/package.json`: `@aparajita/capacitor-secure-storage`,
  `@capacitor-mlkit/barcode-scanning`, `@capacitor/app`, `/filesystem`, `/local-notifications`, `/share`, `/splash-screen`. **No BLE plugin.**
  Custom native code exists for the watch apps: `GarminLink.swift` (iOS) already talks Bluetooth to a Garmin via the Connect IQ SDK.
- iOS `Info.plist` already has `NSBluetoothAlwaysUsageDescription`, `NSBluetoothPeripheralUsageDescription` (text says "Garmin watch you
  picked", so the wording would need to cover the sensor) and `UIBackgroundModes` with `bluetooth-central`. Android manifest has `INTERNET`,
  `SCHEDULE_EXACT_ALARM`, `POST_NOTIFICATIONS`, `VIBRATE`, ... and **no BLUETOOTH_SCAN/BLUETOOTH_CONNECT** (Android 12+) nor
  `uses-feature android.hardware.bluetooth_le` (required=false recommended). There is also an "openGym Offline" Android flavour without INTERNET
  (irrelevant for local BLE).
- What `@capacitor-community/bluetooth-le` needs: `BLUETOOTH_SCAN` (with `neverForLocation` flag) and `BLUETOOTH_CONNECT` for Android 12+,
  `ACCESS_FINE_LOCATION` for <= 11 (**UNVERIFIED** against the plugin's current README, re-check), the iOS usage strings, and an adapter
  implementing the same interface as our Web Bluetooth client (`connect`, `startNotifications`, `read`, `write`, `disconnect`).
- **PWA on Android Chrome can use Web Bluetooth directly** (our current approach). **iPhone: not in Safari/PWA**; only through the Capacitor
  shell (native plugin) or a third-party browser app with Web Bluetooth support (e.g. Bluefy, not a plan). The store builds are made and
  signed by the openGym maintainer on his release machine, not in CI (`docs/APP_STORES.md`), so an iPhone app of a *fork* needs the owner's
  own Apple Developer account and a Mac (iOS build, `ios.yml` runs on a macOS runner).

### A6. Licensing and governance (facts, not legal advice)

- openGym code: **AGPL-3.0-or-later** (`LICENSE`, `frontend/package.json "license"`). `NOTICE.md` adds a section 7 "app store exception"
  (distribution through app stores, "provided the corresponding source code remains available under the AGPL") and a Garmin/closed-library
  exception, both granted by the copyright holder; whether either extends to a fork's own builds is not stated (**ask**).
- **Verified sentence in NOTICE.md:** "A non-commercial fork of openGym may keep the unmodified 180 px media together with this notice. A
  commercial fork, or any other use, needs its own licence from gymvisual.com." Also: "There is no public API, CDN or downloadable media
  pack. Don't hotlink the files or copy them out of this repository or a running instance." and "may not be used to train, prompt or feed any
  AI system". "Non-commercial" is not defined (a free app on GitHub Pages is the clear case; ads, paid store listing, paid sensor bundle is the
  ambiguous zone).
- **CLA** (`CLA.md`): contributor keeps copyright; openGym (Duarte Santos and successors) gets a perpetual licence to relicense under any
  terms "including proprietary or commercial". One signature (comment on the PR) covers all contributions.
- Facts for the four scenarios (decisions in section F):
  - **(a) Fork adding a LiftIQ module:** the fork is a modified version of an AGPL work, so it stays AGPL-3.0-or-later. AGPL section 13:
    users interacting with the modified program over a network must be offered its Corresponding Source; for a static PWA that is typically a
    visible "Source" link to the fork repo. openGym already carries a `REPO` constant (`lib/demo.js`) that points to GitLab and must be
    re-pointed in the fork. The module's code inside the fork is AGPL regardless of where it was authored.
  - **(b) LiftIQ's own repo:** currently **no LICENSE file**, which means default copyright (all rights reserved): nobody (including a fork
    maintainer who is a different legal person; here the owner is the same person) has a documented licence to the code. The owner as sole
    copyright holder may license `packages/liftiq-sensor` any way and also dual-license; if it is consumed by an AGPL fork, the combined
    distribution has to satisfy the AGPL, which means the package's licence must be AGPL-compatible (MIT/Apache-2.0/BSD, or AGPL itself).
    Licensing it permissively (or AGPL) lets third parties reuse it; keeping it proprietary while shipping it in an AGPL fork is not possible
    for the shipped copy (the fork's recipients get it under AGPL). Firmware/hardware may carry other licences (e.g. CERN-OHL, GPL/MIT) than the
    software. Third-party code already in LiftIQ: the exercises dataset (MIT) and its media (Gym visual, see `docs/IMAGE_CREDITS.md`): do not
    ship these in the package.
  - **(c) Contributing upstream:** needs CLA; maintainer may relicense; the contribution must meet "dependency-light", i18n in 25 packs, tests,
    and a maintainer willing to carry hardware-specific code (no hardware on his side to test). Needs agreement first (Discussions > Ideas).
    Modules are first-party, so upstream acceptance means a "LiftIQ sensor" module inside openGym itself.
  - **(d) Non-commercial-fork media rule:** a fork must keep the media unmodified (no resizing, no re-encoding), keep `NOTICE.md`, and stay
    non-commercial. LiftIQ's own use of the same Gym visual images via the hasaneyldrm dataset (`docs/IMAGE_CREDITS.md`) is a separate
    question; inside the fork the media come from openGym's `catalogue/media`, which makes LiftIQ's runtime-linked images obsolete.

---

## B. Recommended architecture

### B1. The `liftiq-sensor` package (stays in the LiftIQ repo)

`packages/liftiq-sensor/` (ES modules, no framework, no DOM except `navigator.bluetooth`/wake lock behind injected adapters, no bundler
needed, tests with `node --test`, same as `app/dev/test`). Contents, mostly moved/copied from `app/dev` (the app then imports the package, so
there is one copy):

| Module | Origin in `app/dev` | Notes |
|---|---|---|
| `transport/web-bluetooth.js` | `ble.js` | implements `Transport` interface: `connect()`, `onPacket(cb)`, `command(bytes)`, `read()`, `disconnect()`, `onDisconnect(cb)` |
| `transport/capacitor-ble.js` (later) | new | same interface over `@capacitor-community/bluetooth-le`, injected, never imported by the core |
| `protocol.js`, `raw-protocol.js` | same | decoder, seq unwrap, dropped-packet count; golden vectors from `tests/compat` reused |
| `session.js` (state machine) | `session.js` | trimmed to what a set needs: connect -> ready check -> record -> stop; no Train-flow UI state |
| `analysis/pulses.js`, `analysis/live-counter.js` | `analysis/` | unchanged; `docs/REP_ANALYSIS.md` is the spec |
| `ready-check.js`, `wakelock.js`, `packet-stats.js` | same | |
| `metrics.js` (new) | from pulses | `summariseSet(pulses, {unit, excluded}) -> VbtSummary` (the object stored on the set) |
| `svg/*.js` (new, W3) | `pulse-chart.js`, `chart.js` | pure string builders: `setTraceSVG`, `loadVelocitySVG`, `repBarsSVG`; usable by the PDF generator (it needs strings, not DOM) |
| `index.js` | | one public surface, semver'd |

Rules: no React, no localStorage, no `t()`; strings are returned as keys/numbers, the host (openGym) formats and translates them. Units
handled in the host. Package licence: **owner decision (F2)**, MIT or Apache-2.0 recommended for compatibility; add `LICENSE` file.

**Stored on the openGym set (small, derived, versioned):**
```
set.vbt = { v:1, src:'liftiq', dev:'LiftIQ-C846', fw:'x.y', at: <ms of first sample>,
            n: <reps counted>, reps:[{ mv:<mean m/s>, pv:<peak m/s>, ms:<concentric ms>, ... }],  // <= ~30 reps x 3-4 numbers
            vl: <velocity loss %>, excl:[<indices excluded>], setup:<rep index count pulled for setup>, q: <quality flags> }
```
Size budget: <= ~300 bytes per set; a 100-workout history with 20 sets stays well under 1 MB (5 MB api body limit and ~5 MB localStorage
are the ceilings; **raw traces never go into `S`**). Optional raw trace (compressed CSV like our per-set CSV) goes to a separate store: the
module's own IndexedDB `liftiq-traces` keyed by (workout id, entry index, set index) or a user-triggered file export; excluded from sync by
design (device-local), survives backup only if the user exports. Honest limitation: IndexedDB can be evicted like localStorage.

### B2. The minimal fork patch footprint

Goal: keep the fork rebasable on upstream `main`. All new code lives in one new directory; touched upstream files get tiny, clearly
marked hunks (`// liftiq:` comments) so conflicts are obvious.

New (no conflicts):
- `frontend/src/modules/liftiq/` : `index.js` (module descriptor + `register()`), `store.js` (own tiny Zustand slice for connection state, kept
  OUT of `S`), `LiftiqSetSheet.jsx` (live count, stop, review), `LiftiqSettings.jsx` (connect page), `StatsCard.jsx`, `reportSection.js`,
  `format.js` (`vbtLabel(set)` like `hrLabel`), `sanitize.js` (`sanitizeVbt`), tests beside them.
- `frontend/src/vendor/liftiq-sensor/` : copy of the package (via `scripts/vendor-liftiq.mjs` pulling a tagged release/commit of the LiftIQ repo
  into this folder, with a `VERSION` file). Alternative: a git dependency in `package.json` (adds an npm dependency, a "hard sell" upstream
  but fine in a fork). Vendoring keeps `npm ci` identical to upstream and the AGPL source in one repo (simplifies section 13 compliance).

Touched upstream files (each a few lines):
1. `frontend/src/lib/modules.js`: add `{ id:'liftiq', group:'training', ... }` to `MODULES`; add to `PRESETS`/`TRAINING` (or leave off in
   presets so it is opt-in).
2. `frontend/src/lib/modules-copy.js` and **all 25** `frontend/src/locales/*.js`: new strings (see A4); `MODULE_KW` words.
3. `frontend/src/views/Workout.jsx`: in `openSetMenu` one gated item; optionally one icon button in `plainRow`; one import. (Largest conflict risk:
   the file changes constantly upstream. Mitigation: put the item construction in `modules/liftiq/index.js` as `setMenuItems(ctx)` and spread it
   in, so the hunk is 2 lines.)
4. `frontend/src/views/settings-pages.js` + `frontend/src/views/Settings.jsx`: one `PAGES` entry, one render branch (+ SEARCH row).
5. `frontend/src/lib/integrations.js` / `views/Integrations.jsx`: optional directory card.
6. `frontend/src/views/Stats.jsx`: one gated section (phase 3).
7. `frontend/src/lib/report-print.js`: one call in `workoutPrintHTML` and `reportPrintHTML` (phase 3).
8. `frontend/src/lib/demo.js` + `useStore.js` + `pages.yml`: standalone flavour (no seed, own `REPO`, own name/icons/manifest, AGPL source link)
   (phase 0). Rebranding avoids confusion with upstream's name/hosting.
9. (later) `frontend/package.json` + Android manifest + `Info.plist`: Capacitor BLE plugin and permissions (phase 5).

Not touched: `finish-workout.js`, `sync-merge.js`, `api/*`, `export-csv.js`/importers (CSV round trip would lose `vbt`; our module ships
its own CSV with velocity columns), `sw.js`.

Merge discipline: `git remote add upstream`, rebase weekly onto `upstream/main`; CI job in the fork that runs openGym's full test suite plus
`scripts/check-locales.mjs`; a test `modules/liftiq/sync-survival.test.js` asserting `set.vbt` survives `buildCompletedWorkout`,
`mergeStates` (sync-merge) and a JSON backup round trip, so an upstream change that breaks it is caught at rebase time.

---

## C. User-visible flow inside openGym

1. Settings > Modules: switch on **LiftIQ sensor**; Settings > LiftIQ sensor: "Connect" (Chrome chooser, filtered by service UUID / `LiftIQ`
   prefix), shows name, battery, firmware, signal; "Forget".
2. Workout screen (guided workout of openGym, with its own exercise card, weight and warm-ups). On a work set, tap the set number -> menu item
   **Record with sensor** (or the small sensor icon on the row). Pre-conditions shown inline: connected, ready-check ("hold still, start when
   the bar is still", from `ready-check.js`; firmware calibration not required as in W2b).
3. **Live sheet** (`LiftiqSetSheet`): big rep counter (from `live-counter.js`), live status (setup/moving), Stop. Screen wake lock on. The set
   row remains visible behind; weight is the row's `w` (openGym's stepper/plates logic untouched).
4. **Stop -> review:** list of detected pulses; the first reps flagged as "setup pull" are excluded by default, with include/exclude toggles
   and a "reps" stepper to correct; per-rep mean/peak velocity and velocity-loss shown. Buttons: **Save to set** / **Discard**.
5. **Save:** sets the row's `r` via the store's existing field path (and `w` if the user changed it in the sheet), writes `set.vbt`, then calls
   the existing tick so openGym does what it always does: marks done, stamps `at`, PR check, **starts the rest timer** (`startRest`) and moves on.
   The sheet closes; the rest timer countdown is the ordinary one.
6. Row shows a one-line label next to the set (like the heart-rate label): e.g. `0.52 m/s  -18%` (module setting for what to show).
7. **Exercise report:** in the exercise's Stats/detail, a "Bar speed" card: per-set bars, load-velocity chart across sets and sessions, velocity
   loss per set; **session report** in the workout detail sheet and a section in the performance-report PDF (SVG from the package).
8. Failure paths: connection lost mid-set -> keep the rep count so far, ask to save or discard (no silent loss); sensor not connected ->
   menu item opens the connect flow; module off -> everything disappears, data stays ("Nothing is deleted", the module rule).

---

## D. What from LiftIQ's current app is reusable

| Area | Verdict |
|---|---|
| `app/dev` Train flow (W2/W2b: `workout.js`, `train-view.js`, `workout-storage.js`, stages UI), `docs/UX_TRAIN_FLOW.md` | **Superseded** by openGym's guided workout (concepts reused: ready check, review with setup pull) |
| Exercise DB/picker (`exercise-db.js`, `exercises.js`, `exercise-media.js`, `tools/exercise-db`, W2d), photos (`photos.js`), history/`storage.js` CSV store | **Superseded** (openGym catalogue, media at 180 px, history). Keep the tools as long as the standalone app lives |
| `app/dev/ble.js`, `protocol.js`, `raw-protocol.js`, `session.js` state machine, `packet-stats.js`, `wakelock.js`, `ready-check.js`, `rest-alert.js` (rest handled by openGym) | **Stay** -> move into `packages/liftiq-sensor` (rest-alert dropped) |
| `app/dev/analysis/pulses.js`, `live-counter.js`, `docs/REP_ANALYSIS.md`, golden tests with `data/recordings` | **Stay** (core value) |
| `pulse-chart.js`, `chart.js` | **Stay**, refactored to string-SVG builders (W3 report) |
| Firmware (`firmware/`), `docs/PROTOCOL.md`, `tests/compat`, `tools/*`, hardware, `tools/release-app.mjs` | **Stay**; protocol rules (additive only, compat tests) now also protect the fork |
| W3 exercise report, W5 export to openGym (Strong CSV / token push) | **Replaced** by the module's report and by writing directly into the set; W5 only as a fallback for users who do not run the fork |
| `app/stable`, `app/dev` PWAs | Keep `app/stable` as the supported standalone until the fork reaches parity; freeze `app/dev` Train flow (bug fixes only); do not delete (see F4) |

---

## E. Phased milestones, effort (S <= 2 days, M ~ 1 week, L > 1 week; one developer plus agents), risks

| # | Milestone | Effort | Exit criteria / main risks |
|---|---|---|---|
| P0 | Fork + standalone flavour: fork upstream, `npm ci`, `vite build` with `VITE_DEMO=1`-like flavour, GitHub Pages workflow, own name/REPO/source link, media kept with NOTICE, run on phone | S-M | Build works on Node 26; **UNVERIFIED** build time/size; pages.yml references `catalogue/media` (large repo clone ~100+ MB of media in fork); Pages needs repo public |
| P1 | **Spike:** hard-wire "Record with sensor" menu item that opens a dummy sheet, connect via Web Bluetooth from the PWA on Android Chrome, show live reps, write `r` and call tick | M | Proves Web Bluetooth in this PWA (background throttling, reconnect, wake lock), proves `onField`+`toggle` path; risk: Workout.jsx internals (props `onField`/`toggle` are inside a huge component) |
| P2 | Extract `packages/liftiq-sensor` in the LiftIQ repo (move, tests green, `app/dev` consumes it), vendoring script, versioning | M | Keep `npm run test:all` and `tests/compat` green; do not touch `app/stable` except via release script |
| P3 | Module proper: modules.js entry, settings page, set sheet with review (include/exclude setup pull), `set.vbt` + sanitiser + label, survival test, i18n 25 packs (script-assisted), vitest tests | L | i18n volume; Workout.jsx merge conflicts; testing without sensor needs a fake `Transport` (reuse our fake sensor from the browser look) |
| P4 | Reports: Stats card, workout detail, PDF section (`report-print.js` hook), module CSV export | M | Needs W3 SVG builders; PDF visual QA via `npm run pdf:check` (A4/Letter, ar RTL) |
| P5 | Capacitor BLE adapter + Android/iOS shells (plugin, permissions, usage strings, own signing/app ids), field test on iPhone | L | Needs Mac + Apple Developer account for iOS; plugin background behaviour; store policy for a fork; App ID/branding vs upstream; AGPL and store terms (F) |
| P6 | Upstream conversation / optional PR (Discussions > Ideas first), CLA, trimmed module without hardware-specific vendor code | M (+ waiting time) | Maintainer may decline (modules are first-party, no hardware he can test); do not block P0-P4 on it |

Cross-cutting risks: (1) merge cost against a fast-moving upstream (Workout.jsx, sheets.jsx, locales change in every release);
(2) 25-locale rule makes every string expensive; (3) single-device Web Bluetooth reliability on Android Chrome (unverified in this host app);
(4) iPhone has no solution before P5; (5) data durability of PWA localStorage (backup discipline); (6) licensing ambiguities in F; (7) openGym
version drift of `S` schema (`vbt` must stay namespaced and versioned); (8) LiftIQ solo-maintainer capacity (two products to keep green).

---

## F. Decisions the owner must make

1. **Fork vs upstream PR vs both.** Recommended: fork now (P0-P4), talk to the maintainer in parallel (P6), design the module so it could be
   upstreamed.
2. **Licence of LiftIQ** (software package, firmware, hardware, docs): none today. For use inside an AGPL fork it must be AGPL-compatible.
   Choose per component (e.g. package MIT/Apache-2.0 or AGPL, firmware GPL/MIT, hardware CERN-OHL), add LICENSE files and a copyright holder
   line. Third-party parts to keep out of the package: hasaneyldrm dataset images (Gym visual).
3. **Fork hosting/branding:** GitHub Pages project page under the owner's account vs own domain; name (must not impersonate upstream), icon,
   REPO/source link (AGPL section 13), analytics off, whether the standalone flavour replaces the "Demo" labels.
4. **Fate of `app/stable` and `app/dev`:** keep stable as the standalone fallback until the fork reaches parity (recommended), freeze dev's Train
   flow, archive when the fork ships. Also whether the fork becomes the primary release channel.
5. **Non-commercial commitment** (the media rule): is the fork guaranteed non-commercial (no ads, no paid app, no paid hardware bundle that
   requires it)? If hardware is sold with the app, consult Gym visual/openGym or drop media.
6. **Store distribution of the fork** (Play/App Store): the openGym app-store exception belongs to its copyright holder; whether it covers a
   fork is a question for the maintainer or a lawyer. Otherwise stay on PWA/APK sideload. Also the Apple Developer account cost.
7. **iPhone:** accept "Android first" until P5, or start P5 early (cost, Mac).
8. **Data policy for raw traces:** keep only derived metrics on the set (recommended) vs also store raw CSV locally/exportable.
9. **Maintenance budget** for upstream rebases, 25 locales and two code bases; decide the cadence (e.g. rebase on every upstream release).
10. **Contact with the maintainer** and CLA signing (only if P6 goes ahead; signature covers all past and future contributions).

---

## G. Who does what

Owner (manual, cannot be delegated to an agent):
- Create the GitHub fork under the owner's account; enable GitHub Pages (source: Actions); decide repo visibility (public required for free
  Pages and for AGPL source offer).
- Decide licences (F2), add them or approve text; name/brand for the fork; sign the CLA if upstreaming; write to the maintainer (Discord or
  Discussions > Ideas); Apple Developer account and Mac for iOS; Play Console/APK signing keys; test with the real sensor and phones (all
  hardware verification: BLE reconnect, wake lock, background behaviour, iPhone); run the Pages workflow approval for first-time contributors.
- Review legal questions with a professional where needed (AGPL section 13 on a hosted PWA, non-commercial definition, store terms).

Agents (can do, inside the repos the owner opens to them):
- In the LiftIQ repo: create `packages/liftiq-sensor`, move code, tests, vendoring script, W3 SVG builders, docs; keep `npm run test:all` and compat tests green.
- In the fork once it exists: standalone flavour patch, module scaffold, set sheet, `vbt` sanitiser, survival tests, locale packs (script +
  review), Stats/PDF sections, Pages workflow, rebase scripts and CI; fake-transport browser tests at 375x812.
- Not possible for an agent: real sensor/phone/iOS testing, store accounts, signing, legal judgement, contacting the maintainer in the owner's name
  without approval.

---

## Appendix: things not verified in this study

- Build and test run of openGym (time, bundle size, test pass); behaviour of the demo flavour in a real browser.
- Web Bluetooth inside openGym on a real phone (background/lock screen throttling, chooser persistence, wake lock interplay).
- Exact Settings.jsx render hook for a new page; whether any restore path re-whitelists set keys (`store/backup-roundtrip.property.test.jsx`,
  `components/backup-restore.js`); `lib/import-csv.js` behaviour for unknown columns.
- Full overlap of exercise ids between openGym's catalogue and LiftIQ's dataset index.
- Current `@capacitor-community/bluetooth-le` permission requirements for Capacitor 8.
- Whether upstream changed anything after 2026-11-22 (all facts are from `main` at the time of the clone).
