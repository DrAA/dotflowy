import { describe, expect, test } from "bun:test";

import {
  bindFocusedTypingCapture,
  captureFocusedNodeText,
  focusedTextToReapply,
} from "./focused-typing";

describe("focusedTextToReapply", () => {
  test("returns captured text when the store still has the snapshot base", () => {
    expect(focusedTextToReapply({ id: "n1", text: "base typed" }, "base")).toBe(
      "base typed",
    );
  });

  test("returns null when store already matches", () => {
    expect(focusedTextToReapply({ id: "n1", text: "same" }, "same")).toBeNull();
  });
});

describe("bindFocusedTypingCapture", () => {
  test("routes captureFocusedNodeText through the bound reader", () => {
    bindFocusedTypingCapture(() => ({ id: "x", text: "from-binder" }));
    expect(captureFocusedNodeText()).toEqual({ id: "x", text: "from-binder" });
    bindFocusedTypingCapture(() => null);
    expect(captureFocusedNodeText()).toBeNull();
  });
});
