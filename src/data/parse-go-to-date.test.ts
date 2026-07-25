import { describe, expect, test } from "bun:test";

import { formatDateFull } from "./date-links";
import {
  goToDateLabel,
  parseDatePickerQuery,
  parseGoToDateQuery,
  pickerDateLabel,
  pickerDateSuggestions,
} from "./parse-go-to-date";

/** Fixed noon local Saturday 2026-07-25 — weekdays/relatives stay stable. */
const NOW = new Date(2026, 6, 25, 12);

describe("parseGoToDateQuery", () => {
  test("ISO fast-path", () => {
    const hit = parseGoToDateQuery("2026-08-12", NOW);
    expect(hit?.key).toBe("2026-08-12");
    expect(hit?.label).toMatch(/^Go to /);
    expect(hit?.label).toContain("2026");
    expect(hit?.label).toContain("12");
  });

  test("rejects invalid ISO calendar days", () => {
    expect(parseGoToDateQuery("2026-13-45", NOW)).toBeNull();
  });

  test("prose absolute dates", () => {
    expect(parseGoToDateQuery("August 12th", NOW)?.key).toBe("2026-08-12");
    expect(parseGoToDateQuery("Aug 12", NOW)?.key).toBe("2026-08-12");
    expect(parseGoToDateQuery("August 12 2026", NOW)?.key).toBe("2026-08-12");
  });

  test("relatives and weekdays", () => {
    expect(parseGoToDateQuery("today", NOW)?.key).toBe("2026-07-25");
    expect(parseGoToDateQuery("to", NOW)?.key).toBe("2026-07-25"); // prefix
    expect(parseGoToDateQuery("tomorrow", NOW)?.key).toBe("2026-07-26");
    expect(parseGoToDateQuery("tom", NOW)?.key).toBe("2026-07-26");
    expect(parseGoToDateQuery("yesterday", NOW)?.key).toBe("2026-07-24");
    expect(parseGoToDateQuery("next Monday", NOW)?.key).toBe("2026-07-27");
    expect(parseGoToDateQuery("in 2 weeks", NOW)?.key).toBe("2026-08-08");
    expect(parseGoToDateQuery("last Friday", NOW)?.key).toBe("2026-07-24");
  });

  test("bare weekday prefers the upcoming day (forwardDate)", () => {
    // Sat Jul 25 → next Friday is Jul 31
    expect(parseGoToDateQuery("Friday", NOW)?.key).toBe("2026-07-31");
  });

  test("rejects non-date prose and short junk", () => {
    expect(parseGoToDateQuery("project alpha", NOW)).toBeNull();
    expect(parseGoToDateQuery("a", NOW)).toBeNull();
    expect(parseGoToDateQuery("", NOW)).toBeNull();
  });

  test("rejects a date buried in longer prose", () => {
    expect(parseGoToDateQuery("meet on August 12th please", NOW)).toBeNull();
  });
});

describe("pickerDateLabel", () => {
  test("short for near relatives, formatDateFull otherwise", () => {
    expect(pickerDateLabel("2026-07-25", "2026-07-25")).toBe("Today");
    expect(pickerDateLabel("2026-07-26", "2026-07-25")).toBe("Tomorrow");
    expect(pickerDateLabel("2026-07-24", "2026-07-25")).toBe("Yesterday");
    expect(pickerDateLabel("2026-01-29", "2026-07-25")).toBe(
      formatDateFull("2026-01-29"),
    );
  });
});

describe("goToDateLabel", () => {
  test("short for near relatives, full otherwise", () => {
    expect(goToDateLabel("2026-07-25", "2026-07-25")).toBe("Go to Today");
    expect(goToDateLabel("2026-07-26", "2026-07-25")).toBe("Go to Tomorrow");
    expect(goToDateLabel("2026-07-24", "2026-07-25")).toBe("Go to Yesterday");
    expect(goToDateLabel("2026-08-12", "2026-07-25")).toBe(
      `Go to ${formatDateFull("2026-08-12")}`,
    );
  });
});

describe("parseDatePickerQuery (stricter [[ picker gate)", () => {
  test("ISO and relatives still work", () => {
    const iso = parseDatePickerQuery("2026-08-12", NOW);
    expect(iso?.key).toBe("2026-08-12");
    expect(iso?.label).toBe(formatDateFull("2026-08-12"));
    expect(parseDatePickerQuery("tomorrow", NOW)).toEqual({
      key: "2026-07-26",
      label: "Tomorrow",
    });
    expect(parseDatePickerQuery("tomo", NOW)?.key).toBe("2026-07-26");
  });

  test("calendar-complete chrono (day-of-month or year) is accepted", () => {
    const april = parseDatePickerQuery("April 22 2026", NOW);
    expect(april?.key).toBe("2026-04-22");
    expect(april?.label).toBe(formatDateFull("2026-04-22"));
    expect(parseDatePickerQuery("Aug 12", NOW)?.key).toBe("2026-08-12");
    expect(parseDatePickerQuery("April 2026", NOW)?.key).toBe("2026-04-01");
  });

  test("bare month / weekday → no date row (Cmd+K still accepts)", () => {
    expect(parseDatePickerQuery("April", NOW)).toBeNull();
    expect(parseDatePickerQuery("Monday", NOW)).toBeNull();
    expect(parseDatePickerQuery("Friday", NOW)).toBeNull();
    expect(parseDatePickerQuery("next Monday", NOW)).toBeNull();
    // Cmd+K unrestricted path still resolves bare weekdays.
    expect(parseGoToDateQuery("Friday", NOW)?.key).toBe("2026-07-31");
  });
});

describe("pickerDateSuggestions", () => {
  test("merges relatives with gated NL and dedupes by key", () => {
    const tomo = pickerDateSuggestions("tomo", NOW);
    expect(tomo).toEqual([{ key: "2026-07-26", label: "Tomorrow" }]);
    const april = pickerDateSuggestions("April 22 2026", NOW);
    expect(april).toEqual([
      { key: "2026-04-22", label: formatDateFull("2026-04-22") },
    ]);
    const iso = pickerDateSuggestions("2026-01-29", NOW);
    expect(iso).toEqual([
      { key: "2026-01-29", label: formatDateFull("2026-01-29") },
    ]);
    expect(pickerDateSuggestions("April", NOW)).toEqual([]);
  });
});
