# Exercise data and previews (W2d)

Status: reference
Last reviewed: 2026-11-23
Purpose: exercise dataset, media licence status and the runtime-link rules used by the dev app. Reference implementation, superseded by the openGym integration (openGym has its own library); the licence status is still current.

## Status of the media licence (read this first)

On 2026-11-22 the project owner decided to display the dataset media through runtime links with attribution. The dataset README/NOTICE tell downstream users to obtain their own Gym visual license before reusing the media; clarification from Gym visual / the dataset author is PENDING. If they object, set EXERCISE_MEDIA_ENABLED_DEFAULT=false or remove the media source — nothing else depends on it.

What that means in the code:
- `EXERCISE_MEDIA_ENABLED_DEFAULT` (one constant in `app/dev/exercise-media.js`) is the default of the Settings switch "Online exercise previews" (Sensor > Training settings). Off = no request to a media host, pictograms/photos only.
- The images and GIFs are NEVER copied into this repository (a test fails if a `.gif` or an exercise-db image appears). They are loaded in the user's browser from the dataset's public repository at a pinned commit, 180x180 only, never shown larger than 180 CSS px.
- Every displayed dataset image or GIF carries "© Gym visual — https://gymvisual.com/" (linked) through ONE shared renderer, `datasetMediaHtml()`; a unit test checks it for images, GIFs, thumbnails and full size.
- Media request failures degrade quietly: primary URL, fallback URL, then the pictogram (caption hidden because nothing from the dataset is shown).

## Sources

| What | Source | Licence |
|---|---|---|
| Names, categories, muscles, equipment, English instruction steps (1,324 exercises) | https://github.com/hasaneyldrm/exercises-dataset, `data/exercises.json` | MIT, © 2026 Hasan Emir Yıldırım. Text in `app/dev/assets/exercise-db/LICENSE-exercises-dataset.txt` (fetched from the dataset's LICENSE, includes its media exception paragraph) |
| Images (`images/*.jpg`) and previews (`videos/*.gif`), 180x180 | the same repository, loaded at runtime | © Gym visual (https://gymvisual.com/), redistributed there with permission; reuse governed by Gym visual's terms; attribution required |
| Seed machine example photos | Wikimedia Commons | see `docs/IMAGE_CREDITS.md` (unchanged) |

Pinned commit: `7455efae41b330c265e7cd4b78dfa848e7ce5ebd` (default branch head on 2026-11-22). Only English text is used (the dataset has no Portuguese).

## Generated index

`tools/exercise-db/build-index.mjs` (node, no dependencies) turns `exercises.json` into `app/dev/assets/exercise-db/`: `exercises.min.json` (compact records), `meta.json` (`sha`, `count`, `generatedAt`, `sourceUrl`, `dataLicense`, `mediaNotice`) and `LICENSE-exercises-dataset.txt`. Size: 851,916 bytes raw, about 107 kB gzipped (1,324 records). Regeneration steps: `app/dev/assets/exercise-db/README.md`. The index is fetched lazily on first use and kept by the service worker's normal same-origin cache (it is deliberately not in the app-shell list: 850 kB). If it cannot be loaded the app runs with the 10 seed machines.

Record keys: `i` id, `n` name, `c` category, `b` body part, `e` equipment, `t` target muscle, `g` muscle group, `s` secondary muscles, `st` English steps, `m` media id, and `im`/`gf` only when the image/GIF file name differs from `<id>-<media id>.jpg|.gif`. Media URLs are `https://cdn.jsdelivr.net/gh/hasaneyldrm/exercises-dataset@<sha>/images/<file>` (primary) and `https://raw.githubusercontent.com/hasaneyldrm/exercises-dataset/<sha>/images/<file>` (fallback); GIFs use `videos/`. Four names with a broken degree sign in the dataset are repaired ("45в°" -> "45°").

## Exercise library in the app

`app/dev/exercise-db.js` (pure, unit tested): the library is the user's custom machines, the 10 seed machines and the dataset (mapped dataset entries are not listed twice). Ids: seeds and custom machines keep their ids and names (saved sets, history and CSV names are unchanged; a test uses old set shapes), dataset entries are `ds-<datasetId>`. Only a small record (`leanExercise`: id, name, machine, muscles, cue, pictogram) is persisted with a workout; dataset details are looked up from the index by id.

Picker: chips "Stack machines" (default: supported equipment plus the user's own machines) and "All"; filters body part / target muscle / equipment; search over name, muscle, equipment (all words must match); recently used first; pages of 40 with infinite scroll (IntersectionObserver, "Show more" button where it is unavailable); "Type your own machine name" is an inline form at the top. Setup screen: target and secondary muscles, equipment, support badge, collapsible "How to do it" (English steps), "Show movement" (the GIF is requested only when this box is opened), beside "Your machine" (own photo, else Wikimedia example, else pictogram).

### Seed machine -> dataset exercise

| Seed id | Dataset exercise | Equipment | Rationale |
|---|---|---|---|
| `seated-cable-row` | 0861 cable seated row | cable | exact match |
| `lat-pulldown` | 2330 cable lat pulldown full range of motion | cable | the only cable entry named lat pulldown (alternatives: 0150 cable bar lateral pulldown, 0198 cable pulldown) |
| `machine-chest-press` | 0576 lever chest press | leverage machine | closest seated machine chest press (0577 has the same name; 2144 "cable seated chest press" is a cable variant, not the machine) |
| `machine-shoulder-press` | 0603 lever shoulder press | leverage machine | plain seated machine shoulder press (0869/2318 are variants) |
| `machine-leg-press` | 1463 sled 45° leg press (side pov) | sled machine | the dataset has no selectorized leg press; this is the standard leg press with a clear side view. Weakest match: plate-loaded sled, picture only |
| `leg-extension` | 0585 lever leg extension | leverage machine | only leg extension machine |
| `leg-curl` | 0599 lever seated leg curl | leverage machine | seated stack leg curl (lying 0586 and kneeling 0582 exist) |
| `triceps-pushdown` | 0241 cable triceps pushdown (v-bar) | cable | standard high-pulley pushdown (0201 "cable pushdown" is the generic name) |
| `cable-biceps-curl` | 0868 cable curl | cable | plain low-pulley curl |
| `cable-fly` (Pec deck) | 0596 lever seated fly | leverage machine | the pec deck |

The mapping is `SEED_DATASET_MAP` in `exercise-db.js`; a test checks that every mapped id exists in the generated index. The seeds keep their own support level (their LiftIQ machine type: "Cable stack"/"Stack machine" = supported) even where the picture shows a lever or sled machine. Seed cards show: own photo > Wikimedia example > dataset thumbnail > pictogram.

## Sensor support classification

`classifyEquipment()` in `exercise-db.js`. Only cable and selectorized stack machines (the weight stack moves vertically) are validated; plate-loaded lever, sled and Smith machines move on an arc or an incline and are experimental; everything else is not supported. Any exercise can still be started: the weight screen shows the badge and the review screen shows a warning for non-supported ones. A test requires every distinct dataset `equipment` value to be listed here.

| Class | Badge | Dataset `equipment` values (count) |
|---|---|---|
| supported | Rep analysis: validated for cable stack | cable (157); also LiftIQ labels "Cable stack", "Stack machine", "selectorized" |
| experimental | Rep analysis: experimental | leverage machine (81), sled machine (15), smith machine (48) |
| not supported | Rep analysis: not supported | body weight (325), dumbbell (294), barbell (154), band (54), kettlebell (41), weighted (36), stability ball (28), ez barbell (23), assisted (15), medicine ball (13), rope (10), roller (8), resistance band (7), bosu ball (3), olympic barbell (2), wheel roller (2), hammer (1, sledge hammer), tire (1), trap bar (1), upper body ergometer (1), skierg machine (1), stationary bike (1), elliptical machine (1), stepmill machine (1) |
| unknown (no badge) | | the user's custom machines, Quick set |

Note: many "leverage machines" in a real gym are weight-stack machines with a lever arm; they stay experimental until a recording per machine type validates the analysis. The "Stack machines" chip therefore lists cable exercises plus the 10 seeds (163 entries).

## Service worker

`app/dev/sw.js` keeps its app-shell strategy. Added: a runtime cache `liftiq-dev-media-v1` only for `cdn.jsdelivr.net` and `raw.githubusercontent.com` URLs of the pinned dataset path (stale-while-revalidate, oldest entries trimmed beyond 200, opaque responses allowed; `<img crossorigin="anonymous">` is used so the responses are normally CORS responses, which count far less against the storage quota than opaque ones). Offline and not cached: the request fails, the page tries the fallback URL and then shows the pictogram. The release tool needs no change (the cache name is derived from `CACHE_PREFIX`). The behaviour is unit tested with a simulated service worker; the browser pane used for checking cannot register service workers, so this was not seen in a real browser.

## Credits

Sensor > Credits lists: exercise data (MIT, © Hasan Emir Yıldırım, link, licence text file, commit), media (© Gym visual, link, "loaded at runtime from the open dataset repository, not stored by LiftIQ"), and the unchanged Wikimedia photo credits.

## Open points

- Clarification from Gym visual / the dataset author on runtime linking (see the status paragraph).
- Whether to pin a newer dataset commit (regenerate the index with the README steps; the seed mapping test catches vanished ids).
- Validation recordings for lever/sled/Smith machines before any of them becomes "supported".
