/** Brand name used as the document title suffix and the fallback when there
 *  is no zoomed node. */
export const APP_TITLE = "aaflowy";

/**
 * Browser tab title for the current view. `nodeName` is the zoomed node's
 * flattened reading text, or `null` when not zoomed (home, settings, loading).
 * An empty zoomed title becomes "Untitled", matching breadcrumb crumbs.
 */
export function formatDocumentTitle(nodeName: string | null): string {
  if (nodeName === null) return APP_TITLE;
  const name = nodeName.trim() || "Untitled";
  return `${name} - ${APP_TITLE}`;
}
