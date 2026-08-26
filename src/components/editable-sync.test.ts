import { describe, expect, test } from "bun:test";

import {
  classifyFocusedStoreSync,
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
});
