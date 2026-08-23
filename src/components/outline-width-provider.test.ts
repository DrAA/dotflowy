import { describe, expect, test } from "bun:test";

import {
  OUTLINE_WIDTH_DEFAULT,
  OUTLINE_WIDTH_MAX,
  OUTLINE_WIDTH_MIN,
  parseOutlineWidth,
} from "./outline-width-provider";

describe("parseOutlineWidth", () => {
  test("empty or invalid input returns the compiled default", () => {
    expect(parseOutlineWidth(null)).toBe(OUTLINE_WIDTH_DEFAULT);
    expect(parseOutlineWidth("")).toBe(OUTLINE_WIDTH_DEFAULT);
    expect(parseOutlineWidth("wide")).toBe(OUTLINE_WIDTH_DEFAULT);
  });

  test("clamps to the allowed range", () => {
    expect(parseOutlineWidth("100")).toBe(OUTLINE_WIDTH_MIN);
    expect(parseOutlineWidth("9999")).toBe(OUTLINE_WIDTH_MAX);
  });

  test("snaps onto the 20px step", () => {
    expect(parseOutlineWidth("725")).toBe(720);
    expect(parseOutlineWidth("735")).toBe(740);
  });
});
