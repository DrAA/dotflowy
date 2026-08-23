import { createContext, use, useEffect, useSyncExternalStore } from "react";

import { OUTLINE_WIDTH_KEY } from "../lib/storage-keys";

/**
 * Outline-column width preference. A device-local setting that sets the
 * outline's max width through one CSS variable (`--outline-max-width` on
 * <html>), NOT synced to the per-user DO -- comfortable column width is a
 * property of the screen, not the account.
 *
 * Mirrors text-size-provider.tsx (useSyncExternalStore over localStorage, a
 * no-flash inline script in __root.tsx). 720px is the compiled baseline
 * (see styles.css) and matches the historical `max-w-[720px]` column.
 */
export const OUTLINE_WIDTH_MIN = 480;
export const OUTLINE_WIDTH_MAX = 1600;
export const OUTLINE_WIDTH_DEFAULT = 720;
export const OUTLINE_WIDTH_STEP = 20;

/** Centered outline column; max-width follows `--outline-max-width`. */
export const OUTLINE_COLUMN_CLASS = "mx-auto max-w-(--outline-max-width)";

interface OutlineWidthProviderState {
  outlineWidth: number;
  setOutlineWidth: (px: number) => void;
}

const OutlineWidthProviderContext =
  createContext<OutlineWidthProviderState | null>(null);

const listeners = new Set<() => void>();

function subscribe(onStoreChange: () => void) {
  listeners.add(onStoreChange);
  const onStorage = (e: StorageEvent) => {
    if (e.key === OUTLINE_WIDTH_KEY) onStoreChange();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(onStoreChange);
    window.removeEventListener("storage", onStorage);
  };
}

/** Clamp + snap a stored/input value onto the allowed step range. */
export function parseOutlineWidth(raw: string | null): number {
  if (raw == null || raw === "") return OUTLINE_WIDTH_DEFAULT;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return OUTLINE_WIDTH_DEFAULT;
  const clamped = Math.min(OUTLINE_WIDTH_MAX, Math.max(OUTLINE_WIDTH_MIN, n));
  return Math.round(clamped / OUTLINE_WIDTH_STEP) * OUTLINE_WIDTH_STEP;
}

function getSnapshot(): number {
  try {
    return parseOutlineWidth(localStorage.getItem(OUTLINE_WIDTH_KEY));
  } catch {
    // localStorage can throw (private mode / disabled); fall back to default.
  }
  return OUTLINE_WIDTH_DEFAULT;
}

function getServerSnapshot(): number {
  return OUTLINE_WIDTH_DEFAULT;
}

function notify() {
  for (const l of listeners) l();
}

// Module scope: reads no component state, so it's a single stable function
// (mirrors text-size-provider's module-scope setter).
function setOutlineWidth(next: number) {
  const px = parseOutlineWidth(String(next));
  try {
    localStorage.setItem(OUTLINE_WIDTH_KEY, String(px));
  } catch {
    // Ignore write failures (private mode); the in-memory notify still applies.
  }
  notify();
}

/**
 * Reflects the width onto <html style="--outline-max-width">. Kept in sync
 * with the inline no-flash script in __root.tsx (same key + variable) so
 * first paint never flashes the default column then resizes.
 */
function applyOutlineWidth(px: number) {
  document.documentElement.style.setProperty("--outline-max-width", `${px}px`);
}

export function OutlineWidthProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const outlineWidth = useSyncExternalStore(
    subscribe,
    getSnapshot,
    getServerSnapshot,
  );

  useEffect(() => {
    applyOutlineWidth(outlineWidth);
  }, [outlineWidth]);

  const value = { outlineWidth, setOutlineWidth };

  return (
    <OutlineWidthProviderContext.Provider value={value}>
      {children}
    </OutlineWidthProviderContext.Provider>
  );
}

export function useOutlineWidth() {
  const ctx = use(OutlineWidthProviderContext);
  if (!ctx)
    throw new Error(
      "useOutlineWidth must be used within an OutlineWidthProvider",
    );
  return ctx;
}
