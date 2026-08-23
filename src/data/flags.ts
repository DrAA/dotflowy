/**
 * Runtime feature flags. One concern: a single switch can be flipped at runtime
 * (localStorage) without a rebuild, so e2e can exercise both paths and a
 * dogfooder can roll back instantly. A flag lives here only while its rollback
 * path does -- `virtualized` (ADR 0019) and `mobile-bar` (ADR 0030) were
 * deleted with their fallbacks once dogfooded.
 */

const MIRRORS_KEY = "dotflowy:flag:mirrors";

// Compiled default ON. Mirrors (ADR 0022) shipped to all users; localStorage
// "off" is the escape hatch if a regression turns up.
const MIRRORS_DEFAULT = true;

/**
 * Whether node mirrors (ADR 0022) are active. Read at render time by the visible-
 * order walk (mirror resolution + path keys) and the mirror create/chrome paths.
 * ON by default for all users; localStorage "off" is the rollback escape hatch.
 * SSR/prerender has no window and never renders the live store anyway
 * (SPA/no-SSR rule), so it falls to the default -- the value there is moot.
 */
export function isMirrorsEnabled(): boolean {
  if (typeof window === "undefined") return MIRRORS_DEFAULT;
  try {
    const v = window.localStorage.getItem(MIRRORS_KEY);
    if (v === "on") return true;
    if (v === "off") return false;
  } catch {
    // localStorage can throw (private mode / disabled); fall back to the default.
  }
  return MIRRORS_DEFAULT;
}

/** Persist the outline in this browser instead of the local Worker Durable Object. */
export const LOCAL_DATA_FLAG_KEY = "dotflowy:flag:local-data";

// Default OFF — outline lives on the backend machine (Wrangler local DO/SQLite
// via `/api/nodes` + `/api/sync`) so every browser on that host sees the same
// data. Opt in to browser-only storage via Settings / localStorage / URL.
const LOCAL_DATA_DEFAULT = false;

/**
 * Whether outline + side-collections stay in this browser and never hit
 * `/api/nodes`, `/api/kv`, `/api/media`, or `/api/sync`. Default OFF (backend
 * on this machine is the product default).
 *
 * Enable: Settings (persists + reload), `"on"` in localStorage, or
 * `?local-data=on`. Disable: Settings, `"off"` in localStorage, or
 * `?local-data=off` (URL wins for that load; does not persist).
 */
export function isLocalDataEnabled(): boolean {
  if (typeof window === "undefined") return LOCAL_DATA_DEFAULT;
  try {
    const q = new URLSearchParams(window.location.search).get("local-data");
    if (q === "on" || q === "1") return true;
    if (q === "off" || q === "0") return false;
    const v = window.localStorage.getItem(LOCAL_DATA_FLAG_KEY);
    if (v === "on") return true;
    if (v === "off") return false;
  } catch {
    // localStorage / URLSearchParams can throw; fall back to the default.
  }
  return LOCAL_DATA_DEFAULT;
}

export function setLocalDataEnabled(enabled: boolean): void {
  try {
    window.localStorage.setItem(LOCAL_DATA_FLAG_KEY, enabled ? "on" : "off");
  } catch {
    // Private mode — the in-memory flag still applies until reload.
  }
}

/** ADR 0058 Phase-2: outline sync via Lunora shapes/mutators instead of custom DO. */
export const LUNORA_SYNC_FLAG_KEY = "dotflowy:flag:lunora-sync";

// Default OFF — Lunora is alpha; classic DO is production. Opt in via Settings
// (synced `account-prefs`) or localStorage / URL for e2e and local dogfood.
const LUNORA_SYNC_DEFAULT = false;

/**
 * Whether outline sync rides Lunora (`/_lunora` + `@lunora/db`) instead of the
 * custom `/api/sync` + `nodesCollection` path (ADR 0058). Default OFF.
 *
 * Kill-switch pairing (ADR 0058): the browser reads this flag (mirrored from
 * synced `account-prefs` on load); Worker MCP reads env force then the same
 * preference on classic DO. Flip env + client together when debugging divergence.
 *
 * Enable: Settings beta toggle (persists + reload), `"on"` in localStorage, or
 * `?lunora-sync=on`. Disable: Settings, `"off"` in localStorage, or
 * `?lunora-sync=off` (URL wins for that load; does not persist).
 */
export function isLunoraSyncEnabled(): boolean {
  // Browser-only mode never opens a sync socket, Lunora included.
  if (isLocalDataEnabled()) return false;
  if (typeof window === "undefined") return LUNORA_SYNC_DEFAULT;
  try {
    const q = new URLSearchParams(window.location.search).get("lunora-sync");
    if (q === "on" || q === "1") return true;
    if (q === "off" || q === "0") return false;
    const v = window.localStorage.getItem(LUNORA_SYNC_FLAG_KEY);
    if (v === "on") return true;
    if (v === "off") return false;
  } catch {
    // localStorage / URLSearchParams can throw; fall back to the default.
  }
  return LUNORA_SYNC_DEFAULT;
}
