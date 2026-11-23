// "Show developer tools" flag (Lab page + debug panel). Default OFF, stored locally; tolerant to
// unavailable storage (private mode etc.).
export const DEV_TOOLS_KEY = "liftiq-dev-tools";

export function isDevToolsEnabled(store = globalThis.localStorage) {
  try { return store?.getItem(DEV_TOOLS_KEY) === "1"; } catch { return false; }
}

export function setDevToolsEnabled(enabled, store = globalThis.localStorage) {
  try { store?.setItem(DEV_TOOLS_KEY, enabled ? "1" : "0"); } catch { /* ignore */ }
  return Boolean(enabled);
}
