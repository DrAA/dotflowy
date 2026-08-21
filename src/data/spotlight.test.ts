import { describe, expect, test } from "bun:test";

import {
  asLine,
  canApplyPadCompensate,
  centerScrollDelta,
  createCenterRafHandle,
  easeOutCubic,
  isMountWellSettled,
  lineOfElement,
  padCompensateDelta,
  remainingWellScroll,
  shouldSkipCenterForSelection,
  takePointerCenterTarget,
  typewriterPadPx,
} from "./spotlight";

type LineEl = {
  matches(sel: string): boolean;
  classList: { contains(c: string): boolean };
  closest(sel: string): LineEl | null;
};

function probe(init: {
  sel?: string[];
  cls?: string[];
  tree?: Record<string, LineEl | null>;
}): LineEl {
  const el: LineEl = {
    matches: (s) => init.sel?.includes(s) ?? false,
    classList: { contains: (c) => init.cls?.includes(c) ?? false },
    closest: (s) => (init.sel?.includes(s) ? el : (init.tree?.[s] ?? null)),
  };
  return el;
}

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

describe("canApplyPadCompensate", () => {
  test("waits for a client viewport", () => {
    expect(canApplyPadCompensate(null, true, 800, 400)).toBe(false);
  });

  test("waits until the list is in the tree", () => {
    expect(canApplyPadCompensate(800, false, 800, 400)).toBe(false);
  });

  test("waits until the list can absorb the well", () => {
    expect(canApplyPadCompensate(800, true, 66, 400)).toBe(false);
  });

  test("applies once the list is tall enough", () => {
    expect(canApplyPadCompensate(800, true, 800, 400)).toBe(true);
  });

  test("applies a zero pad without waiting for height", () => {
    expect(canApplyPadCompensate(800, true, 0, 0)).toBe(true);
  });
});

describe("remainingWellScroll", () => {
  test("is zero when the mode is off", () => {
    expect(remainingWellScroll(0, 0)).toBe(0);
  });

  test("finishes a well that a later scrollTo(0) wiped", () => {
    expect(remainingWellScroll(400, 0)).toBe(400);
  });

  test("is zero once scrollY has cleared the well", () => {
    expect(remainingWellScroll(400, 400)).toBe(0);
    expect(remainingWellScroll(400, 480)).toBe(0);
  });

  test("clamps leftover to maxScroll on a short outline", () => {
    expect(remainingWellScroll(400, 0, 80)).toBe(80);
    expect(remainingWellScroll(400, 80, 80)).toBe(0);
  });
});

describe("isMountWellSettled", () => {
  test("waits while the list is not ready", () => {
    expect(isMountWellSettled(400, 0, 0, false)).toBe(false);
  });

  test("closes when the mode is off", () => {
    expect(isMountWellSettled(0, 0, 0, true)).toBe(true);
  });

  test("closes once scrollY has cleared the well", () => {
    expect(isMountWellSettled(400, 400, 800, true)).toBe(true);
  });

  test("closes a short outline at max scroll", () => {
    expect(isMountWellSettled(400, 80, 80, true)).toBe(true);
    expect(isMountWellSettled(400, 0, 80, true)).toBe(false);
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
    const recorded = new EventTarget();
    expect(takePointerCenterTarget(true, recorded)).toBe(recorded);
  });

  test("returns null when armed but nothing recorded (chrome click)", () => {
    expect(takePointerCenterTarget(true, null)).toBeNull();
  });

  test("returns null when not armed", () => {
    expect(takePointerCenterTarget(false, new EventTarget())).toBeNull();
  });

  test("old always-activeElement centers a chrome click; armed-target does not", () => {
    const line = new EventTarget();
    const oldPointerUp = (activeElement: EventTarget | null) => activeElement;
    const newPointerUp = (armed: boolean, recorded: EventTarget | null) =>
      takePointerCenterTarget(armed, recorded);
    expect(oldPointerUp(line)).toBe(line);
    expect(newPointerUp(true, null)).toBeNull();
  });
});

describe("asLine / lineOfElement", () => {
  const row = probe({ sel: ["li[data-node-id]"] });
  const text = probe({
    cls: ["node-text"],
    tree: { "li[data-node-id]": row },
  });

  test("asLine keeps an already-resolved list row (re-click)", () => {
    expect(asLine(row)).toBe(row);
    expect(asLine(text) ?? lineOfElement(text)).toBe(row);
  });

  test("lineOfElement requires .node-text and ignores a bare list row", () => {
    expect(lineOfElement(text)).toBe(row);
    expect(lineOfElement(row)).toBeNull();
  });

  test("lineOfElement skips the zoomed title and non-row chrome", () => {
    const title = probe({
      cls: ["node-text"],
      tree: {
        "h2.zoomed-title": probe({ sel: ["h2.zoomed-title"] }),
        "li[data-node-id]": row,
      },
    });
    const chrome = probe({});
    expect(lineOfElement(title)).toBeNull();
    expect(lineOfElement(chrome)).toBeNull();
    expect(asLine(chrome)).toBeNull();
  });
});
