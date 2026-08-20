/**
 * Spotlight focus mode (ADR 0033 + ADR 0060). When enabled, the outline dims to
 * 0.3 while a bullet is focused -- EXCEPT that focused bullet, which stays full
 * -- so the line you're editing stands out. Single-node by design: dimmed
 * context is still legible at 0.3, so one bright line against a uniform dim
 * field reads calmer than a ladder of lit ancestors, and it matches the intent
 * (focus on the node).
 *
 * Three halves:
 *  1. A localStorage-backed store for the on/off toggle -- the More-menu
 *     checkbox reads it via `useSpotlightEnabled`, mirroring show-completed.
 *     It's a per-browser view preference, not synced document data.
 *  2. A tiny dim engine that toggles two `<body>` classes: `spotlight-on` (the
 *     mode) and `spotlight-fade` (the input modality). ALL of the dim/light
 *     logic is pure CSS (`:has(.node-text:focus)` + `:focus-within`, see
 *     styles.css) -- no focus listeners, no generated stylesheet, no tree walk
 *     on the dim path. Single-node lighting is exactly what `:focus-within`
 *     expresses, and "dim only while a caret is in the outline" is exactly
 *     `:has(:focus)`, so CSS does both.
 *  3. Typewriter centering (ADR 0060): while the mode is on, a focused list
 *     row is scrolled to the vertical center of the visual viewport. Separate
 *     from the dim -- it only shares the install lifetime. This engine scrolls
 *     `window` from the live rect with an interruptible ease-out slide;
 *     OutlineEditor supplies half-viewport virtualizer padding so the first
 *     and last rows can actually reach center.
 */

import { SPOTLIGHT_KEY } from "../lib/storage-keys";

// -- toggle store -----------------------------------------------------------

const listeners = new Set<() => void>();

export function subscribeSpotlight(onStoreChange: () => void): () => void {
  listeners.add(onStoreChange);
  const onStorage = (e: StorageEvent) => {
    if (e.key === SPOTLIGHT_KEY) onStoreChange();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(onStoreChange);
    window.removeEventListener("storage", onStorage);
  };
}

export function getSpotlightSnapshot(): boolean {
  try {
    return window.localStorage.getItem(SPOTLIGHT_KEY) === "true";
  } catch {
    return false;
  }
}

/** SPA/prerender has no window; spotlight is off during any server pass. */
export function getSpotlightServerSnapshot(): boolean {
  return false;
}

export function setSpotlightEnabled(next: boolean): void {
  try {
    window.localStorage.setItem(SPOTLIGHT_KEY, String(next));
  } catch {
    // localStorage can throw (private mode); the engine still toggles below.
  }
  for (const l of listeners) l();
}

// -- DOM engine -------------------------------------------------------------

const SPOTLIGHT_ON = "spotlight-on";
const SPOTLIGHT_FADE = "spotlight-fade";

let installed = false;
let slideRaf = 0;
const centerRaf = createCenterRafHandle(
  (cb) => requestAnimationFrame(cb),
  (id) => cancelAnimationFrame(id),
);

/** Tracks one rAF so uninstall can drop a queued center before it scrolls. */
export function createCenterRafHandle(
  request: (cb: () => void) => number,
  cancel: (id: number) => void,
): { schedule: (run: () => void) => void; cancel: () => void } {
  let id = 0;
  return {
    schedule(run) {
      cancel(id);
      id = request(() => {
        id = 0;
        run();
      });
    },
    cancel() {
      cancel(id);
      id = 0;
    },
  };
}

// Pointer-driven focus is armed from pointerdown until pointerup/cancel so we
// can wait for the gesture to finish before scrolling. Centering on focusin
// would yank a click-drag text selection as soon as the caret landed.
let pointerArmed = false;
let pointerFocusTarget: EventTarget | null = null;

function clearPointerGesture(): void {
  pointerArmed = false;
  pointerFocusTarget = null;
}

// The dim change eases on a pointer-driven focus and snaps on keyboard nav
// (ADR 0033): a click into a distant bullet can afford a fade, but rapid
// arrow-stepping must feel immediate. We only track the modality; CSS reacts.
const onPointerDown = (e: PointerEvent) => {
  pointerArmed = true;
  // A click on the already-focused row does not fire focusin. Keep the row
  // so pointerup can still center it. Chrome (toolbar, empty well) is not
  // a list row, so this stays null and does not yank.
  pointerFocusTarget = lineOf(e.target);
  document.body.classList.add(SPOTLIGHT_FADE);
};
const onPointerUp = () => {
  const target = takePointerCenterTarget(pointerArmed, pointerFocusTarget);
  clearPointerGesture();
  scheduleCenter(target);
};
const onPointerCancel = () => {
  clearPointerGesture();
};
const onKeyDown = () => {
  clearPointerGesture();
  document.body.classList.remove(SPOTLIGHT_FADE);
};
const onFocusIn = (e: FocusEvent) => {
  if (pointerArmed) {
    pointerFocusTarget = e.target;
    return;
  }
  scheduleCenter(e.target);
};

/** Zoomed title is an h2, not a list row -- centering it would hide the children. */
function lineOf(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof HTMLElement)) return null;
  if (!target.classList.contains("node-text")) return null;
  return target.closest("li[data-node-id]");
}

/** Distance to scroll so `line` sits at the vertical center of `view`. */
export function centerScrollDelta(
  lineTop: number,
  lineHeight: number,
  viewTop: number,
  viewHeight: number,
): number {
  return lineTop + lineHeight / 2 - (viewTop + viewHeight / 2);
}

/** Skip centering when the user is drag-selecting text inside this row. */
export function shouldSkipCenterForSelection(
  isCollapsed: boolean,
  selectionInsideLine: boolean,
): boolean {
  return !isCollapsed && selectionInsideLine;
}

/** Typewriter slide (~one beat). Rapid arrows cancel and retarget. */
export const CENTER_SLIDE_MS = 240;

/** Classic ease-out cubic: fast start, settle into place. */
export function easeOutCubic(t: number): number {
  return 1 - (1 - t) ** 3;
}

/** Half-viewport well so first and last rows can reach center. */
export function typewriterPadPx(viewHeight: number, on: boolean): number {
  return on ? Math.round(viewHeight / 2) : 0;
}

/**
 * Scroll delta for the typewriter well. Mount compensates so n0 is not in the
 * well. Mode flip compensates so the view does not jump. A viewport-only pad
 * change returns 0 -- URL-bar / keyboard resize must not scrollBy mid-gesture.
 */
export function padCompensateDelta(
  prevOn: boolean | null,
  nextOn: boolean,
  prevPad: number,
  nextPad: number,
): number {
  if (prevOn === null) return nextPad;
  if (prevOn === nextOn) return 0;
  return nextPad - prevPad;
}

/** Hold the pad scroll until the real list can absorb it. Spinner height cannot. */
export function canApplyPadCompensate(
  viewHeight: number | null,
  listReady: boolean,
  listHeight: number,
  pad: number,
): boolean {
  if (viewHeight === null) return false;
  if (!listReady) return false;
  if (pad > 0 && listHeight < pad) return false;
  return true;
}

/** Remaining scroll after a later scrollTo(0) wiped a mount/zoom well. */
export function remainingWellScroll(pad: number, scrollY: number): number {
  if (pad <= 0) return 0;
  if (scrollY >= pad) return 0;
  return pad - scrollY;
}

/** Pointerup centers a row the gesture hit. Chrome with no row is null. */
export function takePointerCenterTarget(
  armed: boolean,
  recorded: EventTarget | null,
): EventTarget | null {
  if (!armed) return null;
  return recorded;
}

function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function cancelSlide(): void {
  if (!slideRaf) return;
  cancelAnimationFrame(slideRaf);
  slideRaf = 0;
}

function slideWindowBy(delta: number): void {
  if (Math.abs(delta) < 1) return;
  cancelSlide();
  if (prefersReducedMotion()) {
    window.scrollBy(0, delta);
    return;
  }
  const from = window.scrollY;
  const to = from + delta;
  const started = performance.now();
  const step = (now: number) => {
    const t = Math.min(1, (now - started) / CENTER_SLIDE_MS);
    window.scrollTo({ top: from + (to - from) * easeOutCubic(t), left: 0 });
    if (t < 1) slideRaf = requestAnimationFrame(step);
    else slideRaf = 0;
  };
  slideRaf = requestAnimationFrame(step);
}

function centerLine(li: HTMLElement): void {
  if (!installed) return;
  if (!li.isConnected) return;
  const sel = document.getSelection();
  if (
    sel &&
    shouldSkipCenterForSelection(sel.isCollapsed, li.contains(sel.anchorNode))
  )
    return;
  const rect = li.getBoundingClientRect();
  if (rect.height === 0) return;
  const viewTop = window.visualViewport?.offsetTop ?? 0;
  const viewHeight = window.visualViewport?.height ?? window.innerHeight;
  const delta = centerScrollDelta(rect.top, rect.height, viewTop, viewHeight);
  slideWindowBy(delta);
}

function scheduleCenter(target: EventTarget | null): void {
  const li = lineOf(target);
  if (!li) return;
  // After the browser's own focus-scroll and a layout pass (virtualizer
  // remounts) so the rect we read is the one the user will see.
  centerRaf.schedule(() => {
    if (installed) centerLine(li);
  });
}

export function installSpotlight(): void {
  if (installed) return;
  installed = true;
  clearPointerGesture();
  document.body.classList.add(SPOTLIGHT_ON);
  // Capture phase so the modality is set before focus lands.
  window.addEventListener("pointerdown", onPointerDown, true);
  window.addEventListener("pointerup", onPointerUp, true);
  window.addEventListener("pointercancel", onPointerCancel, true);
  window.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("focusin", onFocusIn, true);
  // Turning the mode on while a line already holds the caret: center it now.
  scheduleCenter(document.activeElement);
}

export function uninstallSpotlight(): void {
  if (!installed) return;
  installed = false;
  clearPointerGesture();
  centerRaf.cancel();
  cancelSlide();
  window.removeEventListener("pointerdown", onPointerDown, true);
  window.removeEventListener("pointerup", onPointerUp, true);
  window.removeEventListener("pointercancel", onPointerCancel, true);
  window.removeEventListener("keydown", onKeyDown, true);
  window.removeEventListener("focusin", onFocusIn, true);
  document.body.classList.remove(SPOTLIGHT_ON, SPOTLIGHT_FADE);
}
