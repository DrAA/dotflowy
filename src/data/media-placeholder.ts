/**
 * Honest export mention for hosted images (ADR 0061). Markdown, OPML, and MCP
 * flatten use this so a private `/api/media/:id` URL never leaks into a
 * shareable file or an agent transcript.
 */
export function imagePlaceholder(count: number): string {
  if (count <= 0) return "";
  return count === 1 ? " [image]" : ` [image ×${count}]`;
}

/** Count attachments per content node id. */
export function countImagesByNode(
  rows: ReadonlyArray<{ nodeId: string }>,
): Map<string, number> {
  const map = new Map<string, number>();
  for (const row of rows) {
    map.set(row.nodeId, (map.get(row.nodeId) ?? 0) + 1);
  }
  return map;
}
