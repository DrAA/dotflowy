// Search-term highlighting for the `?q=` view filter. Pure, DOM-free: maps
// flattened reading text (the same projection `buildQueryFilter` matches on)
// back to source offsets so inline-code.ts can wrap hits in `<mark>`. Mirrors
// the Fuse picker highlight in node-switcher.tsx / move-dialog.tsx, but for
// outline bullets.

import type { FilterOperatorMap } from "./filter-query";

import { CODE_RUN_PATTERN } from "./code";
import {
  DATE_LINK_PATTERN,
  formatDateChipLabel,
  localDateKey,
  parseDateLink,
} from "./date-links";
import { emphasisMarkerLen } from "./emphasis";
import { parseFilterQuery } from "./filter-query";
import { HIGHLIGHT_PATTERN, parseHighlight } from "./highlight";
import { flattenInline } from "./inline-text";
import { LINK_PATTERN } from "./links";
import { spoilerInterior } from "./spoiler";

/** Must match `CODE_SENTINEL` in code.ts -- shields interiors during flatten. */
const CODE_SENTINEL = "\uE000";

interface MappedText {
  text: string;
  toSource: number[];
}

/** Source-space highlight ranges `[start, end]` inclusive, like Fuse indices. */
export type SourceHighlightRange = readonly [number, number];

function pairKey(key: string, value: string | null): string {
  return `${key}:${value ?? ""}`;
}

/** Non-negated terms whose substring should light up in matching rows. */
export function extractHighlightTerms(
  query: string | undefined,
  operators: FilterOperatorMap,
): string[] {
  const parsed = parseFilterQuery(query);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const group of parsed.groups) {
    for (const term of group.terms) {
      if (term.negated) continue;
      let value: string | null = null;
      switch (term.type) {
        case "text":
          value = term.value;
          break;
        case "tag":
          value = term.tag;
          break;
        case "operator":
          if (!operators.get(pairKey(term.key, term.value))) value = term.raw;
          break;
      }
      if (!value) continue;
      const key = value.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(value);
    }
  }
  return out;
}

function concatMapped(a: MappedText, b: MappedText): MappedText {
  return { text: a.text + b.text, toSource: [...a.toSource, ...b.toSource] };
}

function sliceMapped(
  input: MappedText,
  start: number,
  end: number,
): MappedText {
  return {
    text: input.text.slice(start, end),
    toSource: input.toSource.slice(start, end),
  };
}

function mapLabelToToken(
  label: string,
  tokenStart: number,
  tokenEnd: number,
): MappedText {
  const tokenLen = Math.max(1, tokenEnd - tokenStart);
  const toSource: number[] = [];
  for (let i = 0; i < label.length; i++) {
    toSource.push(
      tokenStart +
        Math.min(tokenLen - 1, Math.floor((i * tokenLen) / label.length)),
    );
  }
  return { text: label, toSource };
}

function replaceRunsMapped(
  input: MappedText,
  pattern: string,
  mapRun: (run: string, runStart: number) => MappedText,
): MappedText {
  const re = new RegExp(pattern, "gu");
  const text = input.text;
  let out: MappedText = { text: "", toSource: [] };
  let last = 0;
  for (const m of text.matchAll(re)) {
    const start = m.index ?? 0;
    const run = m[0] ?? "";
    const end = start + run.length;
    out = concatMapped(out, sliceMapped(input, last, start));
    out = concatMapped(out, mapRun(run, start));
    last = end;
  }
  return concatMapped(out, sliceMapped(input, last, text.length));
}

function flattenDateLinksMapped(
  input: MappedText,
  today = localDateKey(),
): MappedText {
  if (!input.text.includes("[[")) return input;
  return replaceRunsMapped(input, DATE_LINK_PATTERN, (tok, start) => {
    const parsed = parseDateLink(tok);
    if (!parsed) {
      return sliceMapped(input, start, start + tok.length);
    }
    const label = formatDateChipLabel(parsed.key, today);
    const flat = parsed.time ? `${label} ${parsed.time}` : label;
    return mapLabelToToken(flat, start, start + tok.length);
  });
}

function stripLinksMapped(input: MappedText): MappedText {
  if (!input.text.includes("[")) return input;
  return replaceRunsMapped(input, LINK_PATTERN, (run, start) => {
    const label = /\[([^\]]*)\]/.exec(run)?.[1] ?? "";
    const labelStart = start + 1;
    return {
      text: label,
      toSource: Array.from(
        { length: label.length },
        (_, i) => input.toSource[labelStart + i]!,
      ),
    };
  });
}

function stripHighlightsMapped(input: MappedText): MappedText {
  if (!input.text.includes("==")) return input;
  return replaceRunsMapped(input, HIGHLIGHT_PATTERN, (run, start) => {
    const { emoji, interior } = parseHighlight(run);
    const interiorStart = start + 2 + (emoji?.length ?? 0);
    return {
      text: interior,
      toSource: Array.from(
        { length: interior.length },
        (_, i) => input.toSource[interiorStart + i]!,
      ),
    };
  });
}

function stripEmphasisMapped(input: MappedText): MappedText {
  if (
    !input.text.includes("*") &&
    !input.text.includes("_") &&
    !input.text.includes("~")
  ) {
    return input;
  }
  const pattern = [
    "\\*\\*[^*\\n]+\\*\\*",
    "~~[^~\\n]+~~",
    "\\*[^*\\n]+\\*",
    "(?<![\\p{L}\\p{N}])_[^_\\n]+_(?![\\p{L}\\p{N}])",
    "~[^~\\n]+~",
  ].join("|");
  return replaceRunsMapped(input, pattern, (run, start) => {
    const markerLen = emphasisMarkerLen(run);
    const innerStart = start + markerLen;
    const innerEnd = start + run.length - markerLen;
    return sliceMapped(input, innerStart, innerEnd);
  });
}

function stripSpoilersMapped(input: MappedText): MappedText {
  if (!input.text.includes("|")) return input;
  return replaceRunsMapped(input, "\\|\\|[^|\\n]+\\|\\|", (run, start) => {
    const interior = spoilerInterior(run);
    const interiorStart = start + 2;
    return {
      text: interior,
      toSource: Array.from(
        { length: interior.length },
        (_, i) => input.toSource[interiorStart + i]!,
      ),
    };
  });
}

function stripMarkupMapped(input: MappedText): MappedText {
  return stripSpoilersMapped(stripEmphasisMapped(stripHighlightsMapped(input)));
}

function stripCodeShieldedMapped(
  input: MappedText,
  stripRest: (masked: MappedText) => MappedText,
): MappedText {
  if (!input.text.includes("`")) return stripRest(input);
  const interiors: MappedText[] = [];
  const masked = replaceRunsMapped(input, CODE_RUN_PATTERN, (run, start) => {
    const interiorStart = start + 1;
    const interiorEnd = start + run.length - 1;
    interiors.push(sliceMapped(input, interiorStart, interiorEnd));
    return {
      text: CODE_SENTINEL,
      toSource: [input.toSource[start]!],
    };
  });
  const stripped = stripRest(masked);
  let i = 0;
  const restored: MappedText = { text: "", toSource: [] };
  for (let j = 0; j < stripped.text.length; j++) {
    if (stripped.text[j] === CODE_SENTINEL) {
      const interior = interiors[i++]!;
      restored.text += interior.text;
      restored.toSource.push(...interior.toSource);
    } else {
      restored.text += stripped.text[j]!;
      restored.toSource.push(stripped.toSource[j]!);
    }
  }
  return restored;
}

/** Flatten `text` to reading form and record each flat char's source index. */
export function buildFlatMap(text: string, today = localDateKey()): MappedText {
  const seed: MappedText = {
    text,
    toSource: Array.from({ length: text.length }, (_, i) => i),
  };
  const dated = flattenDateLinksMapped(seed, today);
  const linked = stripLinksMapped(dated);
  return stripCodeShieldedMapped(linked, stripMarkupMapped);
}

/** Case-insensitive, non-overlapping match ranges in flat text (inclusive). */
export function findFlatMatchRanges(
  flat: string,
  terms: readonly string[],
): SourceHighlightRange[] {
  const lower = flat.toLowerCase();
  const ranges: SourceHighlightRange[] = [];
  for (const term of terms) {
    const needle = term.toLowerCase();
    if (!needle) continue;
    let from = 0;
    while (from <= lower.length - needle.length) {
      const at = lower.indexOf(needle, from);
      if (at === -1) break;
      ranges.push([at, at + needle.length - 1]);
      from = at + needle.length;
    }
  }
  if (ranges.length === 0) return [];
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: SourceHighlightRange[] = [ranges[0]!];
  for (let i = 1; i < ranges.length; i++) {
    const prev = merged[merged.length - 1]!;
    const cur = ranges[i]!;
    if (cur[0] <= prev[1] + 1) {
      prev[1] = Math.max(prev[1], cur[1]);
    } else {
      merged.push(cur);
    }
  }
  return merged;
}

/** Map flat-space ranges to inclusive source-space ranges. */
export function flatRangesToSourceRanges(
  flatRanges: readonly SourceHighlightRange[],
  toSource: readonly number[],
): SourceHighlightRange[] {
  const out: SourceHighlightRange[] = [];
  for (const [flatStart, flatEnd] of flatRanges) {
    if (flatStart >= toSource.length) continue;
    const clampedEnd = Math.min(flatEnd, toSource.length - 1);
    const srcStart = toSource[flatStart]!;
    const srcEnd = toSource[clampedEnd]!;
    out.push([Math.min(srcStart, srcEnd), Math.max(srcStart, srcEnd)]);
  }
  if (out.length === 0) return [];
  out.sort((a, b) => a[0] - b[0]);
  const merged: SourceHighlightRange[] = [out[0]!];
  for (let i = 1; i < out.length; i++) {
    const prev = merged[merged.length - 1]!;
    const cur = out[i]!;
    if (cur[0] <= prev[1] + 1) {
      prev[1] = Math.max(prev[1], cur[1]);
    } else {
      merged.push(cur);
    }
  }
  return merged;
}

/** Highlight ranges in source space for `text` and `terms`, or `undefined`. */
export function computeSourceHighlightRanges(
  text: string,
  terms: readonly string[] | undefined,
): SourceHighlightRange[] | undefined {
  if (!terms?.length || !text) return undefined;
  const mapped = buildFlatMap(text);
  if (mapped.text !== flattenInline(text)) {
    // Safety: mapping must stay aligned with the filter's reading projection.
    return undefined;
  }
  const flatRanges = findFlatMatchRanges(mapped.text, terms);
  if (flatRanges.length === 0) return undefined;
  const sourceRanges = flatRangesToSourceRanges(flatRanges, mapped.toSource);
  return sourceRanges.length > 0 ? sourceRanges : undefined;
}
