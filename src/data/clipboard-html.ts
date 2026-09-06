// Clipboard HTML ↔ markdown-link bridge (ADR 0005 / 0016).
//
// Storage stays `[label](url)` in `node.text`. External apps speak HTML
// hyperlinks (and Word prefers RTF). These helpers are the seam between them:
//
//   - htmlClipboardToText: rich paste (Docs / Word / browser) → source text
//     with markdown links. Returns null when there are no http(s) anchors.
//   - markdownToClipboardHtml: source → a full HTML clipboard document with
//     real <a> tags and <!--StartFragment--> markers (what Word / Docs expect;
//     a bare fragment is often ignored in favour of text/plain markdown).
//   - markdownLinksToRtf: source → RTF with HYPERLINK fields (Word's preferred
//     rich format when both plain and HTML are present).
//   - writeMarkdownToClipboard: async write of plain + html (+ rtf when the
//     ClipboardItem API allows) for node-selection / menu copy paths.
//
// DOMParser is browser-only (bun's test runner has no DOM); the HTML→text
// direction is covered by e2e. The pure emitters are unit-tested.

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

/** Escape RTF control characters in literal text. */
function escapeRtf(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/{/g, "\\{").replace(/}/g, "\\}");
}

/**
 * Turn a markdown source slice into an inline HTML fragment. Link tokens become
 * `<a href="…">label</a>`; everything else is escaped plain text.
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
 * Wrap an HTML fragment in the clipboard document shape Word / Docs / Chromium
 * expect: a full html/body plus the literal `<!--StartFragment-->` /
 * `<!--EndFragment-->` markers (Microsoft CF_HTML). A bare `<a>` fragment is
 * often discarded by Word in favour of text/plain.
 */
export function wrapClipboardHtml(fragment: string): string {
  return (
    `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>` +
    `<!--StartFragment-->${fragment}<!--EndFragment-->` +
    `</body></html>`
  );
}

/**
 * Markdown source (one line or many) → clipboard `text/html` payload with real
 * anchors. Multi-line outline exports become `<br>`-joined lines so bullet
 * markers stay visible as text while links stay clickable.
 */
export function markdownToClipboardHtml(md: string): string {
  const normalized = md.replace(/\r\n?/g, "\n");
  const fragment = normalized.includes("\n")
    ? normalized
        .split("\n")
        .map((line) => markdownLinksToHtml(line))
        .join("<br>")
    : markdownLinksToHtml(normalized);
  return wrapClipboardHtml(fragment);
}

/**
 * Markdown source → RTF with HYPERLINK field codes. Word (desktop) prefers RTF
 * over HTML when both are on the clipboard; without it, paste often falls back
 * to the markdown text/plain and the link is lost.
 */
export function markdownLinksToRtf(text: string): string {
  const normalized = text.replace(/\r\n?/g, "\n");
  let body = "";
  const emitLine = (line: string) => {
    let last = 0;
    for (const m of line.matchAll(LINK_RE())) {
      const start = m.index ?? 0;
      body += escapeRtf(line.slice(last, start));
      const label = m[1] ?? "";
      const url = m[2] ?? "";
      // HYPERLINK field: {\field{\*\fldinst HYPERLINK "url"}{\fldrslt label}}
      body +=
        `{\\field{\\*\\fldinst HYPERLINK "${escapeRtf(url)}"}` +
        `{\\fldrslt ${escapeRtf(label)}}}`;
      last = start + (m[0]?.length ?? 0);
    }
    body += escapeRtf(line.slice(last));
  };
  const lines = normalized.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (i > 0) body += "\\line ";
    emitLine(lines[i]!);
  }
  return `{\\rtf1\\ansi\\deff0 ${body}}`;
}

/**
 * Write markdown to the system clipboard as text/plain + text/html (+ text/rtf
 * when ClipboardItem accepts it). Used by node multi-select and menu "Copy as
 * Markdown" so external apps receive real hyperlinks, not `[label](url)`.
 */
export async function writeMarkdownToClipboard(md: string): Promise<void> {
  const html = markdownToClipboardHtml(md);
  const rtf = markdownLinksToRtf(md);
  if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
    try {
      // Promise-wrapped Blobs: Safari requires them; Chromium accepts them.
      const item: Record<string, Blob | Promise<Blob>> = {
        "text/plain": Promise.resolve(new Blob([md], { type: "text/plain" })),
        "text/html": Promise.resolve(new Blob([html], { type: "text/html" })),
      };
      // text/rtf is optional — some browsers reject unknown MIME on ClipboardItem.
      try {
        await navigator.clipboard.write([
          new ClipboardItem({
            ...item,
            "text/rtf": Promise.resolve(new Blob([rtf], { type: "text/rtf" })),
          }),
        ]);
        return;
      } catch {
        await navigator.clipboard.write([new ClipboardItem(item)]);
        return;
      }
    } catch {
      // Fall through to writeText.
    }
  }
  await navigator.clipboard.writeText(md);
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
