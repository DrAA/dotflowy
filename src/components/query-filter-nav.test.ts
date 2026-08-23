import { afterEach, describe, expect, test } from "bun:test";

import {
  escapeToggleFilterInput,
  setFilterInputController,
} from "./query-filter-nav";

describe("escapeToggleFilterInput", () => {
  afterEach(() => {
    setFilterInputController(null);
  });

  test("opens with skipSuggestions when idle", () => {
    const opens: unknown[] = [];
    let open = false;
    setFilterInputController({
      open: (opts) => {
        opens.push(opts);
        open = true;
      },
      close: () => {
        open = false;
      },
      isOpen: () => open,
    });

    escapeToggleFilterInput();
    expect(opens).toEqual([{ skipSuggestions: true }]);
  });

  test("closes when already open", () => {
    let open = true;
    let closes = 0;
    setFilterInputController({
      open: () => {
        open = true;
      },
      close: () => {
        closes += 1;
        open = false;
      },
      isOpen: () => open,
    });

    escapeToggleFilterInput();
    expect(closes).toBe(1);
    expect(open).toBe(false);
  });
});
