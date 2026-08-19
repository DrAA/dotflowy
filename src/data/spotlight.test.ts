import { describe, expect, test } from "bun:test";

import {
  centerScrollDelta,
  easeOutCubic,
  shouldSkipCenterForSelection,
} from "./spotlight";

describe("centerScrollDelta", () => {
  test("is zero when the line is already centered", () => {
    expect(centerScrollDelta(190, 20, 0, 400)).toBe(0);
  });

  test("negative delta when the line sits above center (scroll the document up)", () => {
    // Line at y=10 (center 20) in a 400px view (center 200) -> -180.
    expect(centerScrollDelta(10, 20, 0, 400)).toBe(-180);
  });

  test("positive delta when the line sits below center (scroll the document down)", () => {
    expect(centerScrollDelta(350, 20, 0, 400)).toBe(160);
  });

  test("accounts for a visualViewport offset (mobile keyboard)", () => {
    // View starts at 100, height 300 -> center 250. Line center 250 -> 0.
    expect(centerScrollDelta(240, 20, 100, 300)).toBe(0);
  });
});

describe("easeOutCubic", () => {
  test("starts at 0 and finishes at 1", () => {
    expect(easeOutCubic(0)).toBe(0);
    expect(easeOutCubic(1)).toBe(1);
  });

  test("is front-loaded (halfway is past the midpoint)", () => {
    expect(easeOutCubic(0.5)).toBeGreaterThan(0.5);
  });
});

describe("shouldSkipCenterForSelection", () => {
  test("does not skip a collapsed caret", () => {
    expect(shouldSkipCenterForSelection(true, true)).toBe(false);
  });

  test("skips a drag-select inside the focused row", () => {
    expect(shouldSkipCenterForSelection(false, true)).toBe(true);
  });

  test("does not skip a selection that lives outside the row", () => {
    expect(shouldSkipCenterForSelection(false, false)).toBe(false);
  });
});
