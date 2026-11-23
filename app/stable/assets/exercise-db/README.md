# exercise-db (generated)

Generated from https://github.com/hasaneyldrm/exercises-dataset (data/exercises.json, MIT). Do not edit by hand.
Files: `exercises.min.json`, `meta.json`, `LICENSE-exercises-dataset.txt`. The dataset's images and GIFs are (c) Gym visual and are **not** stored here; the app links them at runtime (see `docs/EXERCISE_DATA.md`).

Regenerate (no dependencies):

```
# 1. pick the commit and pin it (head of the default branch)
curl -s -A liftiq-build "https://api.github.com/repos/hasaneyldrm/exercises-dataset/commits?per_page=1"
# 2. download the data and the licence at that commit (keep the download outside the repository)
curl -L -o exercises.json "https://raw.githubusercontent.com/hasaneyldrm/exercises-dataset/<sha>/data/exercises.json"
curl -L -o LICENSE.txt    "https://raw.githubusercontent.com/hasaneyldrm/exercises-dataset/<sha>/LICENSE"
# 3. build
node tools/exercise-db/build-index.mjs exercises.json <sha> app/dev/assets/exercise-db --license LICENSE.txt
# 4. check
cd app && npm run test:all
```

If the seed mapping (`SEED_DATASET_MAP` in `app/dev/exercise-db.js`) references an id that no longer exists, the tests fail: pick a new one and update `docs/EXERCISE_DATA.md`.
