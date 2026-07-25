// Cmd+K "go to date" NL parse (ADR 0055) + the stricter `[[` picker gate
// (ADR 0038 amend). Client-only — chrono must not land in the Worker (MCP
// already takes ISO; "tomorrow" is the user's local calendar).
// `date-links.ts` stays dependency-free for Worker share.

import * as chrono from "chrono-node/en";

import {
  addDays,
  dateSuggestions,
  formatDateFull,
  formatDateLabel,
  isValidDateKey,
  localDateKey,
  type DateSuggestion,
} from "./date-links";

const ISO_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Word-prefix relatives (parity with `dateSuggestions` + the old today-only
 *  searchAction). Order is load-bearing: "to" must hit today before tomorrow. */
const RELATIVE_PREFIXES: [word: string, offset: number][] = [
  ["today", 0],
  ["tomorrow", 1],
  ["yesterday", -1],
];

export type GoToDateHit = {
  key: string;
  /** Switcher row label, e.g. "Go to Wednesday, August 12, 2026". */
  label: string;
};

/** Past-leaning phrases must not use chrono's `forwardDate` — it rewrites
 *  "last Friday" into the *next* Friday. Bare weekdays / "next …" still prefer
 *  the future when the query has no past marker. */
function wantsForwardDate(query: string): boolean {
  return !/\b(last|ago|previous|past)\b/i.test(query);
}

type ChronoHit = NonNullable<ReturnType<typeof chrono.parse>[number]>;

/** Whole-query chrono parse, or null. Shared by Cmd+K and the picker gate. */
function parseChronoWholeQuery(q: string, now: Date): ChronoHit | null {
  const hits = chrono.parse(q, now, {
    forwardDate: wantsForwardDate(q),
  });
  const hit = hits[0];
  if (!hit || hit.index !== 0) return null;
  // Whole-query match (trailing junk means this isn't a go-to-date phrase).
  if (hit.text.trim().length !== q.length) return null;
  return hit;
}

/**
 * Parse a Cmd+K query into a local daily-index key, or null when it isn't a
 * date phrase. Relative word-prefix → ISO fast-path → chrono-node/en. Chrono
 * matches must cover the whole trimmed query (no dates buried in prose).
 * Unrestricted chrono (bare `Monday`, `next Friday` ok) — the `[[` picker uses
 * {@link parseDatePickerQuery} instead.
 */
export function parseGoToDateQuery(
  query: string,
  now = new Date(),
): GoToDateHit | null {
  const q = query.trim();
  if (q.length < 2) return null;

  const today = localDateKey(now);
  const lower = q.toLowerCase();

  for (const [word, offset] of RELATIVE_PREFIXES) {
    if (word.startsWith(lower)) {
      const key = addDays(today, offset);
      return { key, label: goToDateLabel(key, today) };
    }
  }

  if (ISO_KEY_RE.test(q)) {
    if (!isValidDateKey(q)) return null;
    return { key: q, label: goToDateLabel(q, today) };
  }

  const hit = parseChronoWholeQuery(q, now);
  if (!hit) return null;

  const key = localDateKey(hit.start.date());
  if (!isValidDateKey(key)) return null;
  return { key, label: goToDateLabel(key, today) };
}

/**
 * Stricter than {@link parseGoToDateQuery} for the `[[` picker (ADR 0038):
 * ISO, today/tomorrow/yesterday prefixes, or a chrono hit that includes a
 * day-of-month OR an explicit year. Bare `April` / `Monday` → null so nodes
 * can still match without a misleading date row.
 */
export function parseDatePickerQuery(
  query: string,
  now = new Date(),
): DateSuggestion | null {
  const q = query.trim();
  if (q.length < 2) return null;

  const today = localDateKey(now);
  const lower = q.toLowerCase();

  for (const [word, offset] of RELATIVE_PREFIXES) {
    if (word.startsWith(lower)) {
      const key = addDays(today, offset);
      return { key, label: pickerDateLabel(key, today) };
    }
  }

  if (ISO_KEY_RE.test(q)) {
    if (!isValidDateKey(q)) return null;
    return { key: q, label: pickerDateLabel(q, today) };
  }

  const hit = parseChronoWholeQuery(q, now);
  if (!hit) return null;
  // Calendar-complete gate: day-of-month OR explicit year (not bare month/weekday).
  if (!hit.start.isCertain("day") && !hit.start.isCertain("year")) {
    return null;
  }

  const key = localDateKey(hit.start.date());
  if (!isValidDateKey(key)) return null;
  return { key, label: pickerDateLabel(key, today) };
}

/**
 * Date rows for the `[[` picker: relatives + ISO from {@link dateSuggestions},
 * plus gated NL chrono ({@link parseDatePickerQuery}). Deduped by key.
 * Labels match Cmd+K day copy: Today/Tomorrow/Yesterday stay short; absolute
 * dates use {@link formatDateFull} (ISO key stays muted trailing chrome).
 */
export function pickerDateSuggestions(
  query: string,
  now = new Date(),
): DateSuggestion[] {
  const today = localDateKey(now);
  const base = dateSuggestions(query, today);
  const nl = parseDatePickerQuery(query, now);
  const merged =
    !nl || base.some((s) => s.key === nl.key) ? base : [...base, nl];
  return merged.map((s) => ({
    key: s.key,
    label: pickerDateLabel(s.key, today),
  }));
}

/** `[[` picker primary label: near relatives stay short; everything else is
 *  the full weekday date Cmd+K / day titles use ({@link formatDateFull}). */
export function pickerDateLabel(key: string, today = localDateKey()): string {
  const short = formatDateLabel(key, today);
  if (short === "Today" || short === "Yesterday" || short === "Tomorrow") {
    return short;
  }
  return formatDateFull(key);
}

/** Near relatives stay short ("Go to Tomorrow"); everything else uses the full
 *  weekday date the day node's title uses. */
export function goToDateLabel(key: string, today = localDateKey()): string {
  return `Go to ${pickerDateLabel(key, today)}`;
}
