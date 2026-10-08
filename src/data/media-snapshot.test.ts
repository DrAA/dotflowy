import { describe, expect, test } from "bun:test";

import {
  bindMediaSnapshot,
  captureMediaForSnapshot,
  isMediaGcSuppressed,
  mediaRowsToReapply,
  reapplyMediaAfterSnapshot,
  withMediaGcSuppressed,
  type MediaSnapshotRow,
} from "./media-snapshot";

const row = (id: string, nodeId: string): MediaSnapshotRow => ({
  id,
  nodeId,
  contentType: "image/png",
  bytes: 1,
  width: 1,
  height: 1,
  createdAt: 1,
});

describe("mediaRowsToReapply", () => {
  test("reapplies stashed rows missing from the collection when the node remains", () => {
    expect(
      mediaRowsToReapply(
        [row("m1", "n1"), row("m2", "n2")],
        new Set(["n1", "n2"]),
        new Set(["m2"]),
      ),
    ).toEqual([row("m1", "n1")]);
  });

  test("skips rows whose node was really deleted", () => {
    expect(
      mediaRowsToReapply([row("m1", "gone")], new Set(["n1"]), new Set()),
    ).toEqual([]);
  });

  test("skips rows already held", () => {
    expect(
      mediaRowsToReapply([row("m1", "n1")], new Set(["n1"]), new Set(["m1"])),
    ).toEqual([]);
  });
});

describe("withMediaGcSuppressed", () => {
  test("nests and clears the suppress flag", () => {
    expect(isMediaGcSuppressed()).toBe(false);
    withMediaGcSuppressed(() => {
      expect(isMediaGcSuppressed()).toBe(true);
      withMediaGcSuppressed(() => {
        expect(isMediaGcSuppressed()).toBe(true);
      });
      expect(isMediaGcSuppressed()).toBe(true);
    });
    expect(isMediaGcSuppressed()).toBe(false);
  });
});

describe("bindMediaSnapshot", () => {
  test("routes capture and reapply through the bound handlers", () => {
    const stashed = [row("m1", "n1")];
    let reapplied: MediaSnapshotRow[] = [];
    bindMediaSnapshot({
      capture: () => stashed,
      reapply: (rows) => {
        reapplied = [...rows];
      },
    });
    expect(captureMediaForSnapshot()).toEqual(stashed);
    reapplyMediaAfterSnapshot(stashed);
    expect(reapplied).toEqual(stashed);
    bindMediaSnapshot({
      capture: () => [],
      reapply: () => {},
    });
    expect(captureMediaForSnapshot()).toEqual([]);
  });
});
