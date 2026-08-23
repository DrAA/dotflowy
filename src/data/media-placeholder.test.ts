import { describe, expect, test } from "bun:test";

import { countImagesByNode, imagePlaceholder } from "./media-placeholder";

describe("imagePlaceholder", () => {
  test("is empty at zero, singular at one, and counted above", () => {
    expect(imagePlaceholder(0)).toBe("");
    expect(imagePlaceholder(-3)).toBe("");
    expect(imagePlaceholder(1)).toBe(" [image]");
    expect(imagePlaceholder(2)).toBe(" [image ×2]");
    expect(imagePlaceholder(7)).toBe(" [image ×7]");
  });
});

describe("countImagesByNode", () => {
  test("tallies attachments per content node id", () => {
    const map = countImagesByNode([
      { nodeId: "a" },
      { nodeId: "b" },
      { nodeId: "a" },
    ]);
    expect(map.get("a")).toBe(2);
    expect(map.get("b")).toBe(1);
    expect(map.has("c")).toBe(false);
  });
});
