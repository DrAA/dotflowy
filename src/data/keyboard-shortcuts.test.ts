import { describe, expect, test } from "bun:test";

import { displayKeyToken, SHORTCUT_GROUPS } from "./keyboard-shortcuts";

describe("keyboard-shortcuts catalog", () => {
  test("every group has at least one item", () => {
    expect(SHORTCUT_GROUPS.length).toBeGreaterThan(0);
    for (const g of SHORTCUT_GROUPS) {
      expect(g.items.length).toBeGreaterThan(0);
    }
  });

  test("Mod+/ is listed as the shortcuts dialog chord", () => {
    const global = SHORTCUT_GROUPS.find((g) => g.title === "Global");
    expect(global?.items.some((i) => i.keys.join("+") === "Mod+/")).toBe(true);
  });

  test("spoiler keeps Mod+Shift+S", () => {
    const formatting = SHORTCUT_GROUPS.find((g) => g.title === "Formatting");
    expect(
      formatting?.items.some((i) => i.keys.join("+") === "Mod+Shift+S"),
    ).toBe(true);
  });

  test("displayKeyToken maps Mod to ⌘ on Mac and Ctrl elsewhere", () => {
    expect(displayKeyToken("Mod", true)).toBe("⌘");
    expect(displayKeyToken("Mod", false)).toBe("Ctrl");
    expect(displayKeyToken("Shift", false)).toBe("⇧");
    expect(displayKeyToken("s", false)).toBe("S");
  });
});
