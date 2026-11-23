// Release channel marker. The release tool (tools/release-app.mjs) rewrites this
// file when it promotes app/dev to app/stable; do not edit it by hand in stable.
// CHANNEL "dev" turns on the DEV badge and the "-dev" version/branding; "stable" is the
// published app. Branding in index.html / manifest / sw.js is rewritten by the release tool too.
export const CHANNEL = "stable";
export const APP_VERSION = "1.1.0";
