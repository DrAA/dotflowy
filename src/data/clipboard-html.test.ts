import { describe, expect, test } from "bun:test";

import {
  markdownLinksToHtml,
  markdownLinksToRtf,
  markdownToClipboardHtml,
  wrapClipboardHtml,
} from "./clipboard-html";

describe("markdownLinksToHtml", () => {
  test("escapes plain text", () => {
    expect(markdownLinksToHtml('a <b> & "c"')).toBe(
      "a &lt;b&gt; &amp; &quot;c&quot;",
    );
  });

  test("turns a markdown link into a real anchor", () => {
    expect(markdownLinksToHtml("[Anthropic](https://anthropic.com)")).toBe(
      '<a href="https://anthropic.com">Anthropic</a>',
    );
  });

  test("preserves surrounding text and multiple links", () => {
    expect(
      markdownLinksToHtml("see [A](https://a.com) and [B](https://b.com) now"),
    ).toBe(
      'see <a href="https://a.com">A</a> and <a href="https://b.com">B</a> now',
    );
  });

  test("escapes label and url attribute text", () => {
    expect(markdownLinksToHtml('[say "hi"](https://x.com/?a=1&b=2)')).toBe(
      '<a href="https://x.com/?a=1&amp;b=2">say &quot;hi&quot;</a>',
    );
  });
});

describe("markdownToClipboardHtml", () => {
  test("wraps the fragment in a StartFragment document Word accepts", () => {
    const html = markdownToClipboardHtml("[Anthropic](https://anthropic.com)");
    expect(html).toContain("<!--StartFragment-->");
    expect(html).toContain("<!--EndFragment-->");
    expect(html).toContain('<a href="https://anthropic.com">Anthropic</a>');
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
  });

  test("joins multi-line markdown with <br>", () => {
    const html = markdownToClipboardHtml(
      "- [A](https://a.com)\n- [B](https://b.com)",
    );
    expect(html).toContain("<br>");
    expect(html).toContain('<a href="https://a.com">A</a>');
    expect(html).toContain('<a href="https://b.com">B</a>');
  });
});

describe("wrapClipboardHtml", () => {
  test("does not insert spaces inside the fragment comments", () => {
    expect(wrapClipboardHtml("x")).toContain(
      "<!--StartFragment-->x<!--EndFragment-->",
    );
  });
});

describe("markdownLinksToRtf", () => {
  test("emits a HYPERLINK field Word can paste", () => {
    const rtf = markdownLinksToRtf(
      "see [Anthropic](https://anthropic.com) now",
    );
    expect(rtf.startsWith("{\\rtf1")).toBe(true);
    expect(rtf).toContain('HYPERLINK "https://anthropic.com"');
    expect(rtf).toContain("Anthropic");
    expect(rtf).toContain("see ");
    expect(rtf).toContain(" now");
  });

  test("escapes RTF control characters in labels", () => {
    const rtf = markdownLinksToRtf("[a{b}\\c](https://x.com)");
    expect(rtf).toContain("a\\{b\\}\\\\c");
  });
});
