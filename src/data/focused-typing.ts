/**
 * Mid-session snapshot helpers for the ADR 0010 typing gap.
 *
 * Kept in `data/` (not `components/editable-sync`) so `collection.ts` can call
 * them without a static import into the editor → plugins → collection cycle.
 * The DOM reader is bound from `editable-sync` once the outline UI loads.
 */

export type FocusedTypingCapture = { id: string; text: string };

/** Whether a focused-DOM stash should overwrite post-snapshot store text. */
export function focusedTextToReapply(
  captured: FocusedTypingCapture | null,
  storeText: string | undefined,
): string | null {
  if (captured == null || storeText === undefined) return null;
  if (storeText === captured.text) return null;
  return captured.text;
}

let captureImpl: () => FocusedTypingCapture | null = () => null;

/** Wire the DOM reader from the editor layer (see `editable-sync.ts`). */
export function bindFocusedTypingCapture(
  fn: () => FocusedTypingCapture | null,
): void {
  captureImpl = fn;
}

/** Read the focused bullet before a mid-session snapshot truncate. */
export function captureFocusedNodeText(): FocusedTypingCapture | null {
  return captureImpl();
}
