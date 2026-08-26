// Focused contentEditable store-sync: decide whether a React snapshot should
// repaint the DOM the user is typing into. OutlineRow and ZoomedTitle share
// this so the two paths cannot drift (ADR 0010).

/**
 * Last-paint key: source text plus a highlight-term suffix. onInput writes the
 * same shape as the row's `renderKey` so a caught-up store is a cheap skip
 * instead of a caret-clobbering rebuild.
 */
export function textPaintKey(text: string, highlightKey: string): string {
  return `${text}\0${highlightKey}`;
}

/** Source-text half of a {@link textPaintKey} (or a legacy bare-text value). */
export function textPaintSource(key: string | null): string {
  if (key == null) return "";
  const i = key.indexOf("\0");
  return i === -1 ? key : key.slice(0, i);
}

/**
 * While a bullet is focused, the contentEditable is source of truth. A store
 * snapshot must not overwrite it when:
 *
 * - **hold** -- this render is stale (live store already moved on, e.g. the
 *   next keystroke committed before this effect ran) OR the snapshot equals
 *   the last server echo while the DOM has newer local text (overlay/ack gap).
 * - **caught-up** -- store matches what onInput already painted; bump the paint
 *   key, do not rebuild.
 * - **apply** -- genuine external write (undo/redo, slash insert, sibling
 *   mirror) that is not an echo of our own typing.
 *
 * A prefix `dom.startsWith(storeText)` guard is NOT used: `"".startsWith` is
 * true for every string, so undo-to-empty (and other prefix shrinks) would
 * never land.
 */
export function classifyFocusedStoreSync(args: {
  storeText: string;
  liveText: string | undefined;
  echoedText: string | undefined;
  syncedKey: string | null;
}): "hold" | "caught-up" | "apply" {
  const { storeText, liveText, echoedText, syncedKey } = args;
  if (liveText != null && liveText !== storeText) return "hold";
  const syncedText = textPaintSource(syncedKey);
  if (syncedText === storeText) return "caught-up";
  if (echoedText === storeText) return "hold";
  return "apply";
}
