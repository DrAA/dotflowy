import { describe, expect, test } from "bun:test";

import {
  isAttachableImage,
  MEDIA_GC_GRACE_MS,
  mediaOrphansToDelete,
  nodeHasImage,
  retainFileBytes,
} from "./media";
import { isMediaGcSuppressed, withMediaGcSuppressed } from "./media-snapshot";

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

describe("media snapshot GC suppress", () => {
  test("withMediaGcSuppressed is visible to the media module flag", () => {
    expect(isMediaGcSuppressed()).toBe(false);
    withMediaGcSuppressed(() => {
      expect(isMediaGcSuppressed()).toBe(true);
    });
    expect(isMediaGcSuppressed()).toBe(false);
  });
});

describe("mediaOrphansToDelete", () => {
  const row = (id: string, nodeId: string, createdAt: number) => ({
    id,
    nodeId,
    createdAt,
  });

  test("skips rows whose node is still present", () => {
    expect(
      mediaOrphansToDelete(
        [row("m1", "n1", 0)],
        new Set(["n1"]),
        MEDIA_GC_GRACE_MS + 1,
      ),
    ).toEqual([]);
  });

  test("skips freshly uploaded orphans inside the grace window", () => {
    const now = 1_000_000;
    expect(
      mediaOrphansToDelete(
        [row("m1", "gone", now - 1_000)],
        new Set(["other"]),
        now,
      ),
    ).toEqual([]);
  });

  test("skips when createdAt is slightly ahead of the client clock", () => {
    const now = 1_000_000;
    expect(
      mediaOrphansToDelete([row("m1", "gone", now + 5_000)], new Set(), now),
    ).toEqual([]);
  });

  test("drops orphans older than the grace window", () => {
    const now = 1_000_000;
    const createdAt = now - MEDIA_GC_GRACE_MS - 1;
    expect(
      mediaOrphansToDelete(
        [row("m1", "gone", createdAt), row("m2", "alive", createdAt)],
        new Set(["alive"]),
        now,
      ),
    ).toEqual([{ id: "m1", nodeId: "gone", ageMs: MEDIA_GC_GRACE_MS + 1 }]);
  });
});
