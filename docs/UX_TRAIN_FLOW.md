# Train flow: UX contract (app/dev, W2b)

Status: reference
Last reviewed: 2026-11-23
Purpose: UX contract of the dev app's Train flow (W2b). Reference implementation, superseded by the openGym integration; kept for the analysis/BLE/session logic it exercises (ready check, session machine, set review).

Gym use: one hand, sweaty fingers. Targets are at least 44 px (primary actions 64-88 px), high contrast, no pop-ups, modals or `confirm()` anywhere in the flow (destructive actions show an inline "Really ...? [Yes] [No]" row, focus on No). The Lab and debug panel are not part of the flow.

## Navigation
- Bottom nav: **Train | History | Sensor**. It is hidden while a set is recording (STOP SET is the only primary control then).
- Header chip (top right) = connection state; tapping it expands an inline panel (name, Connect/Disconnect). The connect row on the machine picker shows only while not connected.
- Persistent **workout header** (from the weight stage on): Back, machine name, `Set N · weight`, sensor chip, and the **stage stepper** Machine > Weight > Ready > Set > Review > Rest (`aria-current="step"`).
- Back (button, browser/Android back): one stage back via History API (`pushState` per stage, `popstate` = step back). Rules: Ready -> Weight -> Machine; Set -> inline "Cancel this set? The recording is discarded."; Review -> inline "Really discard this set?"; Rest/Summary: back does nothing (sets are saved, use the buttons). At the Machine stage the browser leaves the app as usual. Nothing is ever discarded without the inline confirmation; state is persisted in IndexedDB for reload recovery.

## Stages
1. **Machine** (W2d, `docs/EXERCISE_DATA.md`): **Type your own machine name** (inline row at the top, saved as custom machine) -> search (name, muscle, equipment) -> chips **Stack machines** (default: supported equipment + own machines) / **All** -> collapsible Filters (body part, target muscle, equipment) -> Recent (up to 4) -> list of 1,324+ exercises in pages of 40 with infinite scroll (one column cards: thumbnail, name, target muscle, equipment, support badge, attribution line) -> Quick set. Recently used exercises come first. "Finish workout" appears once a set is saved. Each card shows the user's photo, else the default example photo (tag "Example"), else the pictogram, plus "Add your own photo".
2. **Weight** (optional, prefilled from the last set of that machine): "Your machine" photo (own photo, else Wikimedia example, else pictogram) + name, attribution line under the image, for dataset exercises the support badge ("Rep analysis: validated for cable stack / experimental / not supported"), target/secondary muscles and equipment, collapsible **Show movement** (the animated GIF is requested only when opened, 180 px, with the Gym visual caption) and **How to do it** (English steps), big stepper (step from Sensor > Training settings) and "Weight unknown", **Continue**, **Change machine**. Under "Photo, note, name": take photo / gallery / remove photo (own photos only, downscaled to 800 px JPEG, local), note, rename machine, remove custom machine.
3. **Ready check** (replaces the 5 s firmware calibration; no firmware command is sent): sensor card (Connect inline when offline; battery chip), live stillness ring from the stream (`ready-check.js`: all axes vary < 0.3 m/s^2 over 0.75 s and |a| looks like gravity, ready after 1.5 s still). **Start set** is enabled when connected; if pressed before the machine is still it arms: the button shows "Hold still... 1.2 s (tap to cancel)" and recording starts by itself. After 5 s without stillness a hint says the machine seems to be moving (never blocks). Gravity for the analysis comes from the recorded data (`estimateGravity`).
4. **Set**: giant live rep estimate (counts the setup pull), elapsed time, **STOP SET**, **Cancel set (discard)** with inline confirm. A lost connection shows an amber banner; captured data is kept and STOP SET leads to review.
5. **Review** (fits 375x812 without scrolling for the main controls): count, **Include setup pull** switch, **Yes, N reps** / **Edit count** (stepper), editable weight, chart, metrics, per-rep bars, Discard set (inline confirm).
6. **Rest**: set summary line, giant countdown (timestamp based; vibration, beep, flash at zero), -15 s / Skip / +15 s, **Next set**, **Change machine** (keeps the workout and earlier sets, starts a new block), **Finish exercise** -> summary table -> Add another machine / Finish workout.

## Accessibility
Focus moves to the stage heading on every stage change (the set stage focuses its container, never STOP SET); `aria-live` regions for the stage announcement, rep count, ready-check text and review messages; `prefers-reduced-motion` disables the rest flash animation; inputs have labels; the stepper marks the current step.

## Developer tools
Lab (raw capture) and the debug panel live under Sensor > Developer tools, behind a "Show developer tools" switch (stored locally, default off). The old calibrate path (`SessionMachine.startSet`) stays for the Lab and `Calibrate sensor`.

## Exercise data and previews (W2d)
All dataset previews are optional (Sensor > Training settings > "Online exercise previews"; off = no network request) and always carry "© Gym visual — https://gymvisual.com/". The review screen shows a warning for exercises whose equipment is experimental or not supported by the rep analysis; starting is never blocked. Details and the licence status: `docs/EXERCISE_DATA.md`.

## Machine images
Default example photos (Wikimedia Commons, see `docs/IMAGE_CREDITS.md`, `app/dev/assets/machines/credits.json`) are applied through each exercise's `image` field `{url, credit, license, licenseUrl, sourceUrl, label, generic}`; the user's own photo always overrides it; the pictogram is the fallback. The attribution line "Photo: <author>, <license> - Wikimedia Commons" (linked to the source) is shown under the image on the weight screen and all images are listed under Sensor > Credits. The seed exercise `cable-fly` is now "Pec deck (machine fly)" (id kept, "cable fly" is still searchable).
