// The release tool refuses to publish a stable build that still contains dev branding. This pins what that
// check accepts and rejects, in particular the allow-listed storage key of the developer-tools switch.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { findDevBranding, findMediaDefaultProblems } from "../../tools/release-checks.mjs";
import { REPO } from "./helpers.js";

test("the developer-tools storage key liftiq-dev-tools is allowed", () => {
  assert.deepEqual(findDevBranding("dev-tools.js", 'export const DEV_TOOLS_KEY = "liftiq-dev-tools";'), []);
});

test("the real app/dev/dev-tools.js passes the branding check", () => {
  const text = readFileSync(resolve(REPO, "app/dev/dev-tools.js"), "utf8");
  assert.match(text, /liftiq-dev-tools/, "this test exists because dev-tools.js uses that key");
  assert.deepEqual(findDevBranding("dev-tools.js", text), []);
});

test("other dev strings are still rejected, also next to the allowed key", () => {
  const rejected = [
    'const CACHE_NAME = "liftiq-dev-v2";',
    'const KEY = "liftiq-dev-tools-extra";',
    'const KEY = "liftiq-dev-tools2";',
    "<title>LiftIQ Dev</title>",
    '<link href="icon-dev.svg">',
    '<span class="dev-badge">DEV</span>',
    "<!--dev:start-->",
  ];
  for (const text of rejected) {
    assert.notDeepEqual(findDevBranding("x.js", `${text} // liftiq-dev-tools`), [], text);
  }
  assert.deepEqual(findDevBranding("styles.css", ".dev-badge{}"), [], "the harmless css rule stays ignored");
});

test("a release whose exercise media default is still true is rejected, a rewritten copy passes", () => {
  const dev = readFileSync(resolve(REPO, "app/dev/exercise-media.js"), "utf8");
  assert.match(dev, /export const EXERCISE_MEDIA_ENABLED_DEFAULT = true;/, "the dev app keeps the media on by default");
  assert.equal(findMediaDefaultProblems(dev).length, 1, "an unrewritten copy fails the verification");
  const released = dev.replace("EXERCISE_MEDIA_ENABLED_DEFAULT = true;", "EXERCISE_MEDIA_ENABLED_DEFAULT = false;");
  assert.deepEqual(findMediaDefaultProblems(released), []);
  assert.equal(findMediaDefaultProblems("export const SOMETHING = 1;").length, 1, "a missing constant also fails (the switch must exist)");
});

test("the release tool rewrites the media default and verifies it (source check)", () => {
  const tool = readFileSync(resolve(REPO, "tools/release-app.mjs"), "utf8");
  assert.match(tool, /transformExerciseMedia/);
  assert.match(tool, /findMediaDefaultProblems\(read\("exercise-media\.js"\)\)/);
});
