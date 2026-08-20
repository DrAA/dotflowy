import { describe, expect, test } from "bun:test";

import {
  centerScrollDelta,
  createCenterRafHandle,
  easeOutCubic,
  padCompensateDelta,
  shouldSkipCenterForSelection,
  takePointerCenterTarget,
  typewriterPadPx,
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

describe("centerRafHandle", () => {
  test("cancel drops a queued frame so the callback never runs", () => {
    const pending = new Map<number, () => void>();
    let nextId = 1;
    const request = (cb: () => void) => {
      const id = nextId++;
      pending.set(id, cb);
      return id;
    };
    const cancel = (id: number) => {
      pending.delete(id);
    };
    const handle = createCenterRafHandle(request, cancel);
    let ran = false;
    handle.schedule(() => {
      ran = true;
    });
    expect(pending.size).toBe(1);
    handle.cancel();
    expect(pending.size).toBe(0);
    for (const cb of pending.values()) cb();
    expect(ran).toBe(false);
  });
});

describe("typewriterPadPx", () => {
  test("is half the viewport when the mode is on, else 0", () => {
    expect(typewriterPadPx(800, true)).toBe(400);
    expect(typewriterPadPx(801, true)).toBe(401);
    expect(typewriterPadPx(800, false)).toBe(0);
  });
});

describe("padCompensateDelta", () => {
  test("mount with the mode on looks past the well", () => {
    expect(padCompensateDelta(null, true, 0, 400)).toBe(400);
  });

  test("mount with the mode off does not scroll", () => {
    expect(padCompensateDelta(null, false, 0, 0)).toBe(0);
  });

  test("toggle on/off compensates by the pad delta", () => {
    expect(padCompensateDelta(false, true, 0, 400)).toBe(400);
    expect(padCompensateDelta(true, false, 400, 0)).toBe(-400);
  });

  test("a viewport-only pad change does not scroll", () => {
    expect(padCompensateDelta(true, true, 400, 250)).toBe(0);
    expect(padCompensateDelta(false, false, 0, 0)).toBe(0);
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

describe("takePointerCenterTarget", () => {
  test("returns the recorded focusin target while armed", () => {
    const recorded = { id: "n0" };
    expect(takePointerCenterTarget(true, recorded)).toBe(recorded);
  });

  test("returns null when armed but nothing recorded (chrome click)", () => {
    expect(takePointerCenterTarget(true, null)).toBeNull();
  });

  test("returns null when not armed", () => {
    expect(takePointerCenterTarget(false, { id: "n0" })).toBeNull();
  });
});
