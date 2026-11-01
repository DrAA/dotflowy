/**
 * Browser wake → soft sync reconnect.
 *
 * Chromium/Edge sleeping tabs freeze JS and often leave the sync WebSocket
 * half-open (`readyState === OPEN` while nothing arrives). Without a poke on
 * resume, the client only notices when TCP finally fails — often a few seconds
 * after the user is already typing — and a mid-session snapshot then races the
 * contentEditable (ADR 0010 overnight class).
 *
 * Pure DOM wiring: callers pass `reconnect` (soft, keeps cursor). No knowledge
 * of the Effect socket loop.
 */

/** Hide longer than this before a visibility wake triggers soft reconnect.
 *  Brief tab switches stay quiet; Edge sleep / laptop lid / Memory Saver are
 *  minutes–hours. */
export const STALE_HIDDEN_MS = 30_000;

/**
 * Subscribe to wake signals. Returns an unsubscribe that removes every listener.
 * Idempotent per call site — collection.ts installs one binding per sync session.
 */
export function bindSyncWakeHandlers(reconnect: () => void): () => void {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return () => {};
  }

  let hiddenAt: number | null =
    document.visibilityState === "hidden" ? Date.now() : null;

  const onVisibilityChange = () => {
    if (document.visibilityState === "hidden") {
      hiddenAt = Date.now();
      return;
    }
    const away = hiddenAt != null ? Date.now() - hiddenAt : 0;
    hiddenAt = null;
    if (away >= STALE_HIDDEN_MS) reconnect();
  };

  // `online` also fires while a page is still coming up (the radio reporting
  // "up" after the first socket has already started). Reconnecting then drops
  // that socket and a second full snapshot lands a few seconds later, rewinding
  // keystrokes typed into the first one. Only a real offline → online edge
  // is a wake.
  let sawOffline = false;
  const onOffline = () => {
    sawOffline = true;
  };
  const onOnline = () => {
    if (!sawOffline) return;
    sawOffline = false;
    reconnect();
  };

  // Page Lifecycle: Edge/Chrome fire `resume` when a frozen sleeping tab wakes.
  // More precise than visibility alone (a quick alt-tab never freezes).
  const onResume = () => {
    reconnect();
  };

  // bfcache restore — pageshow with persisted, separate from visibility.
  const onPageShow = (event: PageTransitionEvent) => {
    if (event.persisted) reconnect();
  };

  document.addEventListener("visibilitychange", onVisibilityChange);
  window.addEventListener("offline", onOffline);
  window.addEventListener("online", onOnline);
  document.addEventListener("resume", onResume);
  window.addEventListener("pageshow", onPageShow);

  return () => {
    document.removeEventListener("visibilitychange", onVisibilityChange);
    window.removeEventListener("offline", onOffline);
    window.removeEventListener("online", onOnline);
    document.removeEventListener("resume", onResume);
    window.removeEventListener("pageshow", onPageShow);
  };
}

/** @internal Whether a hide duration should soft-reconnect (unit tests). */
export function shouldReconnectAfterHiddenMs(hiddenMs: number): boolean {
  return hiddenMs >= STALE_HIDDEN_MS;
}
