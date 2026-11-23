// Pure helpers for the "no dev branding in the built stable app" check of tools/release-app.mjs.
// Kept separate so tests/compat/release-verify.test.js can exercise them without running a release.

export const FORBIDDEN_DEV_PATTERNS = [/liftiq-dev/i, /icon-dev/i, /LiftIQ Dev/, /class="dev-badge"/, /<!--dev:/];

// Exact strings that contain a forbidden pattern but are NOT branding. Each entry must be an exact token
// (not followed by more identifier characters), so that e.g. `liftiq-dev-v2` (a dev cache name) still fails.
//  - `liftiq-dev-tools`: the localStorage key of the "Show developer tools" switch (app/dev/dev-tools.js). The
//    developer tools are inside the app by design and default to off; renaming the key would orphan every
//    stored switch value, so the key is allow-listed instead.
export const ALLOWED_DEV_TOKENS = [/liftiq-dev-tools(?![\w-])/g];

export function findDevBranding(file, text) {
  let cleaned = text;
  for (const token of ALLOWED_DEV_TOKENS) cleaned = cleaned.replace(token, "");
  const problems = [];
  for (const pattern of FORBIDDEN_DEV_PATTERNS) {
    if (file === "styles.css" && String(pattern).includes("dev-badge")) continue; // harmless unused rule
    if (pattern.test(cleaned)) problems.push(`${file} still matches ${pattern}`);
  }
  return problems;
}

// The released (stable) build must ship with the dataset exercise media OFF by default (licence clarification pending,
// docs/EXERCISE_DATA.md). The release tool rewrites the constant; this check refuses a build where it is not `false`.
// The Settings switch itself stays in the build so the owner can turn the previews on.
export const MEDIA_DEFAULT_PATTERN = /export const EXERCISE_MEDIA_ENABLED_DEFAULT = (true|false);/;

export function findMediaDefaultProblems(text) {
  const match = MEDIA_DEFAULT_PATTERN.exec(text);
  if (!match) return ["exercise-media.js has no `export const EXERCISE_MEDIA_ENABLED_DEFAULT = true|false;` line"];
  if (match[1] !== "false") return ["exercise-media.js still has EXERCISE_MEDIA_ENABLED_DEFAULT = true (the release must ship the dataset media off)"];
  return [];
}
