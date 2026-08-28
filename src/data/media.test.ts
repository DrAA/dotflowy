import { describe, expect, test } from "bun:test";

import { isAttachableImage, nodeHasImage, retainFileBytes } from "./media";

describe("nodeHasImage", () => {
  test("is a pure scan of provided rows and does not start the collection", () => {
    const rows = [{ nodeId: "a" }, { nodeId: "a" }, { nodeId: "c" }];
    expect(nodeHasImage("a", rows)).toBe(true);
    expect(nodeHasImage("b", rows)).toBe(false);
    expect(nodeHasImage("c", [])).toBe(false);
  });
});

describe("isAttachableImage", () => {
  test("accepts raster MIME types and extension fallbacks; rejects SVG", () => {
    expect(
      isAttachableImage(new File([], "x.png", { type: "image/png" })),
    ).toBe(true);
    expect(
      isAttachableImage(new File([], "x.jpg", { type: "image/jpeg" })),
    ).toBe(true);
    expect(isAttachableImage(new File([], "shot.WEBP", { type: "" }))).toBe(
      true,
    );
    expect(
      isAttachableImage(new File([], "icon.svg", { type: "image/svg+xml" })),
    ).toBe(false);
    expect(
      isAttachableImage(new File([], "notes.txt", { type: "text/plain" })),
    ).toBe(false);
  });
});

describe("retainFileBytes", () => {
  test("copies bytes into a new File so clipboard blobs survive async work", async () => {
    const src = new Uint8Array([137, 80, 78, 71]);
    const file = new File([src], "dot.png", { type: "image/png" });
    const copy = await retainFileBytes(file);
    expect(copy).not.toBe(file);
    expect(copy.name).toBe("dot.png");
    expect(copy.type).toBe("image/png");
    expect(new Uint8Array(await copy.arrayBuffer())).toEqual(src);
  });
});
