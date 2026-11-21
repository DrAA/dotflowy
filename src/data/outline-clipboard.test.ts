import { describe, expect, test } from "bun:test";

import {
  appendOutlinePayloadToHtml,
  decodeOutlineClipboardPayload,
  encodeOutlineClipboardPayload,
  outlineClipboardContentIds,
  outlineClipboardHasImages,
  outlinePasteTargetIds,
  stripImagePlaceholders,
  type OutlineClipboardPayload,
} from "./outline-clipboard";
import { buildTreeIndex, makeNode } from "./tree";

describe("stripImagePlaceholders", () => {
  test("removes counted and singular placeholders", () => {
    expect(stripImagePlaceholders("- hello [image]")).toBe("- hello");
    expect(stripImagePlaceholders("- a [image ×2]\n- b [image]")).toBe(
      "- a\n- b",
    );
  });
});

describe("outline clipboard encode/decode", () => {
  test("round-trips image slots", () => {
    const payload: OutlineClipboardPayload = {
      v: 1,
      images: [
        {
          slot: 0,
          items: [
            {
              contentType: "image/png",
              width: 2,
              height: 2,
              data: btoa("png"),
            },
          ],
        },
      ],
    };
    const again = decodeOutlineClipboardPayload(
      encodeOutlineClipboardPayload(payload),
    );
    expect(again).toEqual(payload);
    expect(outlineClipboardHasImages(again)).toBe(true);
  });

  test("embeds into clipboard HTML before EndFragment", () => {
    const html =
      "<!DOCTYPE html><html><body><!--StartFragment-->x<!--EndFragment--></body></html>";
    const payload: OutlineClipboardPayload = {
      v: 1,
      images: [
        {
          slot: 0,
          items: [
            {
              contentType: "image/png",
              width: 1,
              height: 1,
              data: btoa("x"),
            },
          ],
        },
      ],
    };
    const out = appendOutlinePayloadToHtml(html, payload);
    expect(out).toContain("<!--aaflowy-outline:");
    expect(out.indexOf("<!--aaflowy-outline:")).toBeLessThan(
      out.indexOf("<!--EndFragment-->"),
    );
  });
});

describe("outlineClipboardContentIds", () => {
  test("DFS content ids match markdown emit order", () => {
    const root = makeNode({
      id: "r",
      parentId: null,
      prevSiblingId: null,
      text: "root",
    });
    const a = makeNode({
      id: "a",
      parentId: "r",
      prevSiblingId: null,
      text: "a",
    });
    const b = makeNode({
      id: "b",
      parentId: "r",
      prevSiblingId: "a",
      text: "b",
    });
    const index = buildTreeIndex([root, a, b]);
    expect(outlineClipboardContentIds(index, ["r"])).toEqual(["r", "a", "b"]);
    expect(outlinePasteTargetIds("anchor", ["a", "b"])).toEqual([
      "anchor",
      "a",
      "b",
    ]);
  });
});
