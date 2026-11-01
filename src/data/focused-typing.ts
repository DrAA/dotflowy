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

export type TextLayer = { id: string; text: string };

/**
 * Local text a sync frame must not rewind.
 *
 * Pending field layers (queued, then coalesced, then the PATCH already on the
 * wire) always win over a server copy that doesn't match them. The focused
 * contentEditable wins last, but only once this client has a server echo for
 * that id and the DOM has moved off it — otherwise a first snapshot, or another
 * page's edit, would be stuck behind whatever the span happened to show.
 *
 * Nothing is carried forward from a previous frame. After blur, only a patch
 * still queued or on the wire is protected, so deleting back to the last echo
 * is not resurrected.
 */
export function nextUnconfirmedText(args: {
  echo: (id: string) => string | undefined;
  layers: readonly TextLayer[];
  focused: TextLayer | null;
}): Map<string, string> {
  const next = new Map<string, string>();
  for (const u of args.layers) {
    if (args.echo(u.id) !== u.text) next.set(u.id, u.text);
  }
  if (!args.focused) return next;
  const echo = args.echo(args.focused.id);
  if (echo === undefined || args.focused.text === echo) {
    if (echo !== undefined && args.focused.text === echo) {
      const pending = args.layers.some(
        (u) => u.id === args.focused!.id && u.text !== echo,
      );
      if (!pending) next.delete(args.focused.id);
    }
    return next;
  }
  next.set(args.focused.id, args.focused.text);
  return next;
}

/**
 * Text to write for one sync op. A matching server copy confirms the local
 * edit and drops it from the unconfirmed map.
 */
export function resolveProtectedText(
  id: string,
  serverText: string,
  unconfirmed: Map<string, string>,
): string {
  const local = unconfirmed.get(id);
  if (local == null) return serverText;
  if (local === serverText) {
    unconfirmed.delete(id);
    return serverText;
  }
  return local;
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
