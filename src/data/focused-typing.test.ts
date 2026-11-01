import { describe, expect, test } from "bun:test";

import {
  bindFocusedTypingCapture,
  captureFocusedNodeText,
  focusedTextToReapply,
  nextUnconfirmedText,
  resolveProtectedText,
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

describe("nextUnconfirmedText", () => {
  test("keeps keystrokes that have moved past the last server echo", () => {
    const echo = new Map([["n", "hello"]]);
    const next = nextUnconfirmedText({
      echo: (id) => echo.get(id),
      layers: [{ id: "n", text: "hello!" }],
      focused: { id: "n", text: "hello!!" },
    });
    expect(next.get("n")).toBe("hello!!");
  });

  test("does not treat the focused span as local before any server echo", () => {
    const next = nextUnconfirmedText({
      echo: () => undefined,
      layers: [],
      focused: { id: "n", text: "typed before first snapshot" },
    });
    expect(next.size).toBe(0);
  });

  test("lets another page's text through when the DOM still matches the echo", () => {
    const next = nextUnconfirmedText({
      echo: () => "hello",
      layers: [],
      focused: { id: "n", text: "hello" },
    });
    expect(next.has("n")).toBe(false);
  });
});

describe("resolveProtectedText", () => {
  test("writes local text over a stale server copy and confirms when it matches", () => {
    const pending = new Map([["n", "hello!"]]);
    expect(resolveProtectedText("n", "hello", pending)).toBe("hello!");
    expect(pending.get("n")).toBe("hello!");
    expect(resolveProtectedText("n", "hello!", pending)).toBe("hello!");
    expect(pending.has("n")).toBe(false);
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
