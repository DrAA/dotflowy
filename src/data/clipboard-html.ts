// Clipboard HTML ↔ markdown-link bridge (ADR 0005 / 0016).
//
// Storage stays `[label](url)` in `node.text`. External apps speak HTML
// hyperlinks. These two pure-ish helpers are the seam between them:
//
//   - htmlClipboardToText: rich paste (Docs / Word / browser) → source text
//     with markdown links, so a paste that only carries the URL in HTML still
//     lands as a folded link. Returns null when there are no http(s) anchors
//     (caller keeps text/plain).
//   - markdownLinksToHtml: source slice → HTML fragment with real <a> tags so
//     copy/cut into another document pastes as a hyperlink, not `[label](url)`
//     literal text.
//
// DOMParser is browser-only (bun's test runner has no DOM); the HTML→text
// direction is covered by e2e. markdownLinksToHtml is regex-pure and unit-tested.

import {
  encodeUrlForMarkdown,
  hasLink,
  isHttpUrl,
  sanitizeLinkLabel,
} from "./links";

/** Same shape as links.ts's LINK_RE — capturing groups for label + url. */
const LINK_RE = () => /\[([^\]]*)\]\(([^)]*)\)/g;

const BLOCK_TAGS = new Set([
  "p",
  "div",
  "li",
  "tr",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "br",
  "hr",
  "blockquote",
  "pre",
  "section",
  "article",
  "header",
  "footer",
  "ul",
  "ol",
  "table",
]);

/** Escape text for an HTML text node / attribute value. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Turn a markdown source slice into an HTML fragment. Link tokens become
 * `<a href="…">label</a>`; everything else is escaped plain text. Used by
 * copy/cut so external editors receive a real hyperlink.
 */
export function markdownLinksToHtml(text: string): string {
  if (!text.includes("[")) return escapeHtml(text);
  let out = "";
  let last = 0;
  for (const m of text.matchAll(LINK_RE())) {
    const start = m.index ?? 0;
    out += escapeHtml(text.slice(last, start));
    const label = m[1] ?? "";
    const url = m[2] ?? "";
    out += `<a href="${escapeHtml(url)}">${escapeHtml(label)}</a>`;
    last = start + (m[0]?.length ?? 0);
  }
  out += escapeHtml(text.slice(last));
  return out;
}

/**
 * Clipboard `text/html` → a plain string with markdown links substituted for
 * every http(s) `<a href>`. Surrounding rich formatting is flattened to text
 * (bold/italic etc. are not reconstructed — only links are load-bearing for
 * the round-trip). Block boundaries become newlines so a multi-paragraph
 * paste can still take the structural path (ADR 0044). Returns null when the
 * HTML has no convertible anchors (caller keeps text/plain).
 */
export function htmlClipboardToText(html: string): string | null {
  if (!html || !/<a\s/i.test(html)) return null;
  // DOMParser is a browser API; paste.ts only runs in the client.
  if (typeof DOMParser === "undefined") return null;
  const doc = new DOMParser().parseFromString(html, "text/html");
  if (!doc.body) return null;

  const walk = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) {
      return node.textContent ?? "";
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return "";
    const el = node as HTMLElement;
    const tag = el.tagName.toLowerCase();
    if (
      tag === "script" ||
      tag === "style" ||
      tag === "meta" ||
      tag === "head" ||
      tag === "noscript"
    ) {
      return "";
    }
    if (tag === "br" || tag === "hr") return "\n";
    if (tag === "a") {
      const href = (el.getAttribute("href") ?? "").trim();
      const label = sanitizeLinkLabel(el.textContent ?? "");
      if (label && isHttpUrl(href)) {
        return `[${label}](${encodeUrlForMarkdown(href)})`;
      }
      return label;
    }
    let out = "";
    for (const child of el.childNodes) {
      out += walk(child);
    }
    if (BLOCK_TAGS.has(tag) && out && !out.endsWith("\n")) out += "\n";
    return out;
  };

  const raw = walk(doc.body);
  // Collapse runs of spaces/tabs but keep newlines (structural paste needs them).
  const text = raw
    .replace(/[^\S\n]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!text || !hasLink(text)) return null;
  return text;
}
