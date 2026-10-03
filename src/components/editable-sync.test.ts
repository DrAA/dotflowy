import { describe, expect, test } from "bun:test";

import {
  blurReconcileStoreText,
  classifyFocusedStoreSync,
  focusedTextToReapply,
  shouldHoldUnfocusedAckGap,
  shouldKeepMountedDom,
  textPaintKey,
  textPaintSource,
} from "./editable-sync";

describe("textPaintKey", () => {
  test("round-trips the source text even when highlightKey is empty", () => {
    expect(textPaintSource(textPaintKey("hello", ""))).toBe("hello");
    expect(textPaintSource(textPaintKey("hello", "foo"))).toBe("hello");
  });

  test("reads a legacy bare-text syncedRef (no null separator)", () => {
    expect(textPaintSource("hello")).toBe("hello");
    expect(textPaintSource(null)).toBe("");
  });
});

describe("blurReconcileStoreText", () => {
  test("returns null when DOM already matches the store", () => {
    expect(blurReconcileStoreText("hello", "hello")).toBeNull();
  });

  test("returns DOM text when ahead of the store (ack/echo gap)", () => {
    expect(blurReconcileStoreText("hello typed", "hello")).toBe("hello typed");
  });
});

describe("shouldHoldUnfocusedAckGap", () => {
  test("holds when store equals echo but syncedKey still has newer DOM text", () => {
    expect(
      shouldHoldUnfocusedAckGap({
        storeText: "base",
        echoedText: "base",
        syncedKey: textPaintKey("base typed", ""),
      }),
    ).toBe(true);
  });

  test("does not hold when store has caught up to the DOM", () => {
    expect(
      shouldHoldUnfocusedAckGap({
        storeText: "base typed",
        echoedText: "base",
        syncedKey: textPaintKey("base typed", ""),
      }),
    ).toBe(false);
  });

  test("does not hold without an echo seed", () => {
    expect(
      shouldHoldUnfocusedAckGap({
        storeText: "base",
        echoedText: undefined,
        syncedKey: textPaintKey("base typed", ""),
      }),
    ).toBe(false);
  });
});

describe("classifyFocusedStoreSync", () => {
  test("holds a stale render when the live store has already moved on", () => {
    expect(
      classifyFocusedStoreSync({
        storeText: "a",
        liveText: "ab",
        echoedText: undefined,
        syncedKey: textPaintKey("ab", ""),
      }),
    ).toBe("hold");
  });

  test("holds an echo that lags the local DOM (overlay/ack gap)", () => {
    expect(
      classifyFocusedStoreSync({
        storeText: "hell",
        liveText: "hell",
        echoedText: "hell",
        syncedKey: textPaintKey("hello", ""),
      }),
    ).toBe("hold");
  });

  test("marks caught-up when the store matches what onInput painted", () => {
    expect(
      classifyFocusedStoreSync({
        storeText: "hello",
        liveText: "hello",
        echoedText: "hell",
        syncedKey: textPaintKey("hello", ""),
      }),
    ).toBe("caught-up");
  });

  test("applies undo-to-empty (must not hold on a prefix of the DOM)", () => {
    expect(
      classifyFocusedStoreSync({
        storeText: "",
        liveText: "",
        echoedText: "hello",
        syncedKey: textPaintKey("hello", ""),
      }),
    ).toBe("apply");
  });

  test("applies undo that shrinks to a prefix of the typed text", () => {
    expect(
      classifyFocusedStoreSync({
        storeText: "he",
        liveText: "he",
        echoedText: "hello",
        syncedKey: textPaintKey("hello", ""),
      }),
    ).toBe("apply");
  });

  test("applies a slash/programmatic write that is not an echo", () => {
    expect(
      classifyFocusedStoreSync({
        storeText: "/todo",
        liveText: "/todo",
        echoedText: "old",
        syncedKey: textPaintKey("old", ""),
      }),
    ).toBe("apply");
  });

  test("after snapshot seed, overlay drop to synced base holds (stale-tab gap)", () => {
    // Snapshot seeded echoedText=base; PATCH ack drops overlay so store falls
    // back to base while DOM still has typed text — must hold, not apply.
    expect(
      classifyFocusedStoreSync({
        storeText: "base",
        liveText: "base",
        echoedText: "base",
        syncedKey: textPaintKey("base typed", ""),
      }),
    ).toBe("hold");
  });

  test("without an echo seed, overlay drop applies (the overnight bug)", () => {
    expect(
      classifyFocusedStoreSync({
        storeText: "base",
        liveText: "base",
        echoedText: undefined,
        syncedKey: textPaintKey("base typed", ""),
      }),
    ).toBe("apply");
  });
});

describe("shouldKeepMountedDom", () => {
  test("keeps non-empty focused DOM ahead of the store", () => {
    expect(
      shouldKeepMountedDom({
        focused: true,
        domText: "base typed",
        storeText: "base",
      }),
    ).toBe(true);
  });

  test("paints store when remount leaves an empty focused span", () => {
    // Snapshot truncate remounts a fresh empty contentEditable; treating "" as
    // ahead of store would keep the empty span and lose re-layered typing.
    expect(
      shouldKeepMountedDom({
        focused: true,
        domText: "",
        storeText: "base typed",
      }),
    ).toBe(false);
  });

  test("paints store when unfocused", () => {
    expect(
      shouldKeepMountedDom({
        focused: false,
        domText: "ahead",
        storeText: "base",
      }),
    ).toBe(false);
  });
});

describe("focusedTextToReapply", () => {
  test("returns captured text when the store still has the snapshot base", () => {
    expect(focusedTextToReapply({ id: "n1", text: "base typed" }, "base")).toBe(
      "base typed",
    );
  });

  test("returns null when store already matches (no double write)", () => {
    expect(
      focusedTextToReapply({ id: "n1", text: "base typed" }, "base typed"),
    ).toBeNull();
  });

  test("returns null when the node vanished from the snapshot", () => {
    expect(
      focusedTextToReapply({ id: "gone", text: "typed" }, undefined),
    ).toBeNull();
  });
});
