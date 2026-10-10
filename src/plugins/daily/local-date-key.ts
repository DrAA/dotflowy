/**
 * Reactive local calendar day for badges / week strip / date chips.
 *
 * `localDateKey()` alone is not enough in the SPA: React Compiler can skip
 * re-rendering a day badge when its props are unchanged, so after midnight
 * (or an overnight sleep) yesterday's pill still says "Today" until something
 * notifies. This store re-checks on focus / visibility / next local midnight,
 * and {@link refreshLocalDateKey} lets This week / Today buttons force a
 * check before minting today's shell.
 */

import { useSyncExternalStore } from "react";

import { localDateKey } from "../../data/date-links";

let snapshot = localDateKey();
const listeners = new Set<() => void>();
let midnightTimer: ReturnType<typeof setTimeout> | null = null;
let windowBound = false;

function notify(): void {
  for (const l of listeners) l();
}

/** Ms until the next local midnight (clamped to ≥1 so a 0 never busy-loops). */
export function msUntilNextLocalMidnight(now = new Date()): number {
  const next = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() + 1,
    0,
    0,
    0,
    0,
  );
  return Math.max(1, next.getTime() - now.getTime());
}

function scheduleMidnight(): void {
  if (typeof window === "undefined") return;
  if (midnightTimer != null) clearTimeout(midnightTimer);
  midnightTimer = setTimeout(() => {
    midnightTimer = null;
    refreshLocalDateKey();
    scheduleMidnight();
  }, msUntilNextLocalMidnight());
}

function onWindowSignal(): void {
  refreshLocalDateKey();
}

function bindWindow(): void {
  if (windowBound || typeof window === "undefined") return;
  windowBound = true;
  window.addEventListener("focus", onWindowSignal);
  document.addEventListener("visibilitychange", onWindowSignal);
  scheduleMidnight();
}

function unbindWindowIfIdle(): void {
  if (listeners.size > 0 || typeof window === "undefined") return;
  windowBound = false;
  window.removeEventListener("focus", onWindowSignal);
  document.removeEventListener("visibilitychange", onWindowSignal);
  if (midnightTimer != null) {
    clearTimeout(midnightTimer);
    midnightTimer = null;
  }
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  bindWindow();
  // Defer the rollover check — never notify synchronously inside subscribe
  // (that re-enters React while another component is rendering).
  queueMicrotask(() => {
    if (listeners.has(cb)) refreshLocalDateKey();
  });
  return () => {
    listeners.delete(cb);
    unbindWindowIfIdle();
  };
}

function getSnapshot(): string {
  return snapshot;
}

/** Re-read the wall clock; notify subscribers when the local day changed. */
export function refreshLocalDateKey(): boolean {
  const next = localDateKey();
  if (next === snapshot) return false;
  snapshot = next;
  notify();
  return true;
}

/** Current subscribed snapshot (tests / non-React callers). */
export function getLocalDateKeySnapshot(): string {
  return snapshot;
}

/** Reactive `YYYY-MM-DD` for the user's local calendar day. */
export function useLocalDateKey(): string {
  return useSyncExternalStore(subscribe, getSnapshot, localDateKey);
}
