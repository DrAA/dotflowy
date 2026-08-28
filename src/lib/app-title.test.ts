import { describe, expect, test } from "bun:test";

import { APP_TITLE, formatDocumentTitle } from "./app-title";

describe("formatDocumentTitle", () => {
  test("bare brand when there is no zoomed node", () => {
    expect(formatDocumentTitle(null)).toBe(APP_TITLE);
  });

  test("prefixes the zoomed node's name", () => {
    expect(formatDocumentTitle("Projects")).toBe("Projects - aaflowy");
  });

  test("trims surrounding whitespace", () => {
    expect(formatDocumentTitle("  Inbox  ")).toBe("Inbox - aaflowy");
  });

  test("empty zoomed title becomes Untitled", () => {
    expect(formatDocumentTitle("")).toBe("Untitled - aaflowy");
    expect(formatDocumentTitle("   ")).toBe("Untitled - aaflowy");
  });
});
