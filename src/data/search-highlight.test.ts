import { describe, expect, test } from "bun:test";

import { CORE_FILTER_OPERATORS } from "./core-filter-operators";
import { buildFilterOperatorMap } from "./filter-query";
import { flattenInline } from "./inline-text";
import {
  buildFlatMap,
  computeSourceHighlightRanges,
  extractHighlightTerms,
  findFlatMatchRanges,
  flatRangesToSourceRanges,
} from "./search-highlight";

const ops = buildFilterOperatorMap(CORE_FILTER_OPERATORS);

describe("extractHighlightTerms", () => {
  test("collects free text and tags, skips negated and resolved operators", () => {
    expect(extractHighlightTerms("hello #work -nope is:todo", ops)).toEqual([
      "hello",
      "#work",
    ]);
  });

  test("includes unknown operators as free text", () => {
    expect(extractHighlightTerms("is:foo", ops)).toEqual(["is:foo"]);
  });
});

describe("buildFlatMap", () => {
  test("stays aligned with flattenInline on plain text", () => {
    const text = "plain hello world";
    expect(buildFlatMap(text).text).toBe(flattenInline(text));
  });

  test("maps folded link labels back to source", () => {
    const text = "see [Docs](http://x.com)";
    const mapped = buildFlatMap(text);
    expect(mapped.text).toBe(flattenInline(text));
    const ranges = findFlatMatchRanges(mapped.text, ["docs"]);
    const source = flatRangesToSourceRanges(ranges, mapped.toSource);
    expect(text.slice(source[0]![0], source[0]![1] + 1)).toBe("Docs");
  });

  test("maps emphasis interiors back to source", () => {
    const text = "**bold** word";
    const mapped = buildFlatMap(text);
    expect(mapped.text).toBe("bold word");
    const ranges = findFlatMatchRanges(mapped.text, ["bold"]);
    const source = flatRangesToSourceRanges(ranges, mapped.toSource);
    expect(text.slice(source[0]![0], source[0]![1] + 1)).toBe("bold");
  });
});

describe("computeSourceHighlightRanges", () => {
  test("returns undefined when no terms match", () => {
    expect(computeSourceHighlightRanges("hello", ["xyz"])).toBeUndefined();
  });

  test("finds case-insensitive plain-text hits", () => {
    expect(computeSourceHighlightRanges("Hello world", ["hello"])).toEqual([
      [0, 4],
    ]);
  });

  test("highlights inside folded link labels", () => {
    const text = "see [Docs](http://x.com)";
    expect(computeSourceHighlightRanges(text, ["docs"])).toEqual([[5, 8]]);
  });
});
