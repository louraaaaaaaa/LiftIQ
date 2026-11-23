// The release tool refuses to publish a stable build that still contains dev branding. This pins what that
// check accepts and rejects, in particular the allow-listed storage key of the developer-tools switch.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { findDevBranding } from "../../tools/release-checks.mjs";
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
