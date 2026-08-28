import { useParams } from "@tanstack/react-router";
import { useLayoutEffect } from "react";

import { flattenNodeText } from "../data/node-links";
import { getTreeIndex, useNode } from "../data/tree-store";
import { formatDocumentTitle } from "../lib/app-title";

/**
 * Keeps `document.title` in sync with the zoomed page title: "Node - aaflowy"
 * when zoomed, just "aaflowy" at home. Subscribes via {@link useNode} so a
 * rename of the zoomed node updates the tab, while typing in a child does not
 * re-render this. Mounted once in `__root.tsx` inside the auth gate.
 */
export function DocumentTitle() {
  const nodeId = useParams({ strict: false }).nodeId ?? null;
  const node = useNode(nodeId ?? "");
  const title = formatDocumentTitle(
    nodeId && node ? flattenNodeText(getTreeIndex(), node.text) : null,
  );

  useLayoutEffect(() => {
    document.title = title;
  }, [title]);

  return null;
}
