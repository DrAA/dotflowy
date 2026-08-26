import type { Node } from "./schema";

import { bibleRefsToMarkdownLinks } from "../plugins/route-bible/bible";
import { paragraphRoundTrips } from "./markdown-import";
import { imagePlaceholder } from "./media-placeholder";
import { childrenOf, type TreeIndex } from "./tree";

/** Two spaces per depth level (CommonMark-friendly, readable). */
const INDENT = "  ";

/**
 * The line prefix for a node: a GFM task checkbox when it's a task, else a
 * plain bullet. Paragraph nodes also use `- ` -- marker-less paste lines are
 * bullets, so bare-line export no longer round-trips paragraph kind.
 */
function prefixFor(node: Node, text: string): string {
  if (node.kind === "paragraph") return paragraphRoundTrips(text) ? "" : "- ";
  if (node.isTask) return node.completed ? "- [x] " : "- [ ] ";
  return "- ";
}

function emit(
  index: TreeIndex,
  id: string,
  depth: number,
  lines: string[],
  path: Set<string>,
  imageCounts?: ReadonlyMap<string, number>,
): void {
  const node = index.byId.get(id);
  if (!node) return;
  // A mirror windows its SOURCE (ADR 0022), so the content -- text, task state,
  // and the whole subtree -- is read from `mirrorOf`. Markdown cannot carry
  // mirror-ness, and dropping the content is not an option: a mirror flattens to
  // an independent copy (ADR 0044, round-trip exception 3). Without this resolve
  // the exporter emits an empty childless bullet for every mirror, silently
  // losing the windowed content from every copy. A broken mirror (source gone)
  // falls back to its own stored snapshot text.
  const content = index.byId.get(node.mirrorOf ?? id) ?? node;
  // `content.text` is mostly already the markdown source (links `[label](url)`,
  // `#tags`, inline `code`). Route-bible chips are the exception: they store
  // plain reference text and derive the URL at render time, so export projects
  // them to portable markdown links. Empty text yields a bare `- ` bullet,
  // preserving structure. See ADR 0017.
  const text = bibleRefsToMarkdownLinks(content.text);
  const extra = imagePlaceholder(imageCounts?.get(content.id) ?? 0);
  lines.push(INDENT.repeat(depth) + prefixFor(content, text) + text + extra);
  // A mirror nested inside its own source's subtree would recurse forever: its
  // text is emitted once (above) and the walk does not descend. `path` is the
  // ANCESTOR chain, not a global seen-set -- one source mirrored into two
  // branches must expand fully in both.
  if (path.has(content.id)) return;
  path.add(content.id);
  // Full subtree, regardless of collapsed/completed/filter: childrenOf returns
  // the raw ordered children (view state never reaches here).
  for (const child of childrenOf(index, content.id)) {
    emit(index, child.id, depth + 1, lines, path, imageCounts);
  }
  path.delete(content.id);
}

/**
 * Serialize one or more subtrees to a nested markdown list. Each id in `rootIds`
 * becomes a top-level line; its full subtree is emitted beneath it, indented two
 * spaces per level. Never headings, so depth never changes a node's syntax: a
 * bullet is `- `, a task `- [ ] `, a paragraph a bare line (ADR 0045). Pure and
 * view-agnostic -- its only inputs are the index and the roots. See ADR 0017.
 *
 * The inverse is `markdown-import.ts`; the pair is held to
 * `parse(outlineToMarkdown(t)) === t` (ADR 0044) with three documented
 * exceptions, one of which is the mirror flattening `emit` performs above.
 */
export function outlineToMarkdown(
  index: TreeIndex,
  rootIds: string[],
  imageCounts?: ReadonlyMap<string, number>,
): string {
  const lines: string[] = [];
  for (const id of rootIds) emit(index, id, 0, lines, new Set(), imageCounts);
  return lines.join("\n");
}
