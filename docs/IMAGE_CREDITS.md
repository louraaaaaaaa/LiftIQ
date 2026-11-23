# Image credits

Status: reference
Last reviewed: 2026-11-23
Purpose: credits of the default machine photos shipped in `app/dev/assets/machines/` (dev-app reference implementation).

Default machine preview images shipped in `app/dev/assets/machines/`. Machine-readable data: `app/dev/assets/machines/credits.json` (keyed by exercise id). All images come from Wikimedia Commons, retrieved 2026-11-22.

See also `docs/EXERCISE_DATA.md`: the open exercise dataset's pictures and GIFs (c) Gym visual are a separate source, loaded at runtime (never stored in the repo) with their own attribution; they do not replace these files. The picture priority is: the user's own photo, then these Wikimedia examples, then the dataset thumbnail, then the pictogram.

Changes applied to every image: resized to 800 px on the longest side and converted to JPEG (quality 80); EXIF removed. Derived from a Wikimedia-generated rendition of the original file (the original-resolution download was throttled).

## Images (TASL: Title, Author, Source, License)

### lat-pulldown (`lat-pulldown.jpg`)
- Title: "Diverging Lat Pulldown Machine" (File:Diverging Lat Pulldown Machine.jpg)
- Author: Teddyhtsai
- Source: https://commons.wikimedia.org/wiki/File:Diverging_Lat_Pulldown_Machine.jpg
- License: CC0 1.0 - https://creativecommons.org/publicdomain/zero/1.0/ (attribution not required, given anyway)
- Alternative candidate (not shipped): "Lat pulldown machine 20180112" by Santeri Viinamaki, CC BY-SA 4.0, https://commons.wikimedia.org/wiki/File:Lat_pulldown_machine_20180112.jpg

### leg-extension (`leg-extension.jpg`)
- Title: "Leg Extension" (File:Leg Extension.jpg)
- Author: Aliva Sahoo
- Source: https://commons.wikimedia.org/wiki/File:Leg_Extension.jpg
- License: CC BY-SA 4.0 - https://creativecommons.org/licenses/by-sa/4.0/
- Note: the machine carries its manufacturer's own logo (not an overlay).

### cable-fly (`cable-fly.jpg`), shown as "Pec deck (machine fly)"
- Title: "Pec deck Fly" (File:Pec deck Fly.jpg)
- Author: Aliva Sahoo
- Source: https://commons.wikimedia.org/wiki/File:Pec_deck_Fly.jpg
- License: CC BY-SA 4.0 - https://creativecommons.org/licenses/by-sa/4.0/
- Note: a weight-stack pec deck; the seed exercise (id `cable-fly`) is named after it.

### seated-cable-row, triceps-pushdown, cable-biceps-curl (`cable-station.jpg`, one shared file, generic cable station)
- Shown in the app as "Example photo — cable station" (not specific to these exercises). credits.json keeps one entry per exercise id, all pointing at `cable-station.jpg`.
- Title: "Multifunctional cable and row machines in a gym" (File:Multifunctional cable and row machines in a gym.jpg)
- Author: San Francisco Foghorn (Flickr)
- Source: https://commons.wikimedia.org/wiki/File:Multifunctional_cable_and_row_machines_in_a_gym.jpg
- License: CC BY 2.0 - https://creativecommons.org/licenses/by/2.0/

### No image (`file: null` in credits.json)
machine-chest-press, machine-shoulder-press, machine-leg-press, leg-curl: no acceptable weight-stack photo without people was found (available ones were plate-loaded, Smith machines, or showed people).

## License obligations for the app

- Attribution must be shown in the app, either next to the image or on an About/Credits screen. Show at least: title, author, license name linked to the license URL, and the source link (all available in `credits.json`). Also state that the image was modified (the changes note).
- CC BY-SA 4.0 ("ShareAlike") applies to the adapted image itself: anyone receiving the resized JPEG gets it under CC BY-SA 4.0. The images are shipped as separate files and are not combined into the app's code, so the app code is not subject to ShareAlike. Do not bake text, UI or other copyrighted material into the image files.
- CC BY 2.0 requires attribution and a note of changes; CC0 requires nothing.
- No NC (NonCommercial) or ND (NoDerivatives) images are used, which keeps the app free to be modified, resized and distributed.
- The photos show third-party equipment; no recognisable people appear in the shipped images.

## Adding or replacing an image

1. Search Wikimedia Commons only. Accept: CC0, Public Domain (PD-self / PD-author etc.), CC BY 2.0-4.0, CC BY-SA 2.0-4.0. Reject: any NC/ND, GFDL-only, fair use, unknown or missing license, a visible commercial watermark, and recognisable faces. Prefer weight-stack machines, side or three-quarter view, nobody on the machine.
2. Check the license on the file description page (not only the API field) and record the Commons description URL.
3. Resize to max 800 px, JPEG quality ~80, strip EXIF/GPS, save as `app/dev/assets/machines/<exercise-id>.jpg` (keep the total under about 1 MB).
4. Add or update the entry in `credits.json`: `file`, `title`, `author` (plain text), `license`, `licenseUrl`, `sourceUrl`, `originalUrl`, `changes`, `retrievedAt` (ISO date), `notes`. For exercises without a photo use `{ "file": null, "reason": "..." }`.
5. Update this document.

## In the app

`credits.json` is fetched at startup and applied to the seed exercises (`applyImageCredits` in `exercises.js`). The attribution line is shown under the image on the weight screen, all images are listed under Sensor > Credits. The test `app/dev/test/train-flow.test.js` checks the integrity (files exist, author/license/sourceUrl present, no NC/ND, no orphan files, service worker cache list).
