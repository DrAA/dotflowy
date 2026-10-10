import { afterEach, describe, expect, test } from "bun:test";

import {
  getLocalDateKeySnapshot,
  msUntilNextLocalMidnight,
  refreshLocalDateKey,
} from "./local-date-key";

describe("msUntilNextLocalMidnight", () => {
  test("is positive and lands on the next calendar day", () => {
    const now = new Date(2026, 9, 9, 20, 51, 0);
    const ms = msUntilNextLocalMidnight(now);
    expect(ms).toBeGreaterThan(0);
    const land = new Date(now.getTime() + ms);
    expect(land.getFullYear()).toBe(2026);
    expect(land.getMonth()).toBe(9);
    expect(land.getDate()).toBe(10);
    expect(land.getHours()).toBe(0);
    expect(land.getMinutes()).toBe(0);
  });
});

describe("refreshLocalDateKey", () => {
  afterEach(() => {
    // Snap the module snapshot back to the real wall clock so other tests
    // (and a long-lived worker) don't inherit a forced day.
    refreshLocalDateKey();
  });

  test("returns false when the day has not changed", () => {
    expect(refreshLocalDateKey()).toBe(false);
    expect(getLocalDateKeySnapshot()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
