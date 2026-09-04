import { describe, expect, test } from "bun:test";

import { markdownLinksToHtml } from "./clipboard-html";

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
