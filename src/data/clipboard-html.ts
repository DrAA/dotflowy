// Clipboard HTML ↔ markdown-link / emphasis bridge (ADR 0005 / 0016 / 0025).
//
// Storage stays `[label](url)` and `**bold**` / `*italic*` / … in `node.text`.
// External apps speak HTML (and Word prefers RTF). These helpers are the seam:
//
//   - htmlClipboardToText: rich paste (Docs / Word / browser) → source text
//     with markdown links. Returns null when there are no http(s) anchors.
//   - markdownToClipboardHtml: source → a full HTML clipboard document with
//     real <a>/<b>/<i> tags, optional data-URI <img>s, and <!--StartFragment-->
//     markers (what Word / Docs expect; a bare fragment is often ignored in
//     favour of text/plain markdown).
//   - markdownLinksToRtf: source → RTF with HYPERLINK fields + emphasis runs
//     (Word's preferred rich format when both plain and HTML are present).
//   - writeMarkdownToClipboard: async write of plain + html (+ rtf when the
//     ClipboardItem API allows, and when no images — Word prefers RTF and would
//     otherwise drop HTML data-URI images).
//
// DOMParser is browser-only (bun's test runner has no DOM); the HTML→text
// direction is covered by e2e. The pure emitters are unit-tested.

import {
  BOLD_PATTERN,
  ITALIC_PATTERN,
  ITALIC_UNDERSCORE_PATTERN,
  STRIKETHROUGH_PATTERN,
  UNDERLINE_PATTERN,
  emphasisMarkerLen,
} from "./emphasis";
import {
  encodeUrlForMarkdown,
  hasLink,
  isHttpUrl,
  LINK_PATTERN,
  sanitizeLinkLabel,
} from "./links";
import {
  appendOutlinePayloadToHtml,
  outlineClipboardHasImages,
  type OutlineClipboardImage,
  type OutlineClipboardPayload,
} from "./outline-clipboard";

/** Trailing export placeholders from outlineToMarkdown (ADR 0061). */
const IMAGE_PLACEHOLDER_RE = / \[image(?: ×\d+)?\]/g;

const MD_LINK_RE = /^\[([^\]]*)\]\(([^)]*)\)$/;

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

/** Alternation matching OPML export precedence: links before emphasis doubles
 *  before singles. Built per call — a `g` RegExp carries `lastIndex`. */
function inlineTokenRegex(): RegExp {
  return new RegExp(
    [
      LINK_PATTERN,
      BOLD_PATTERN,
      STRIKETHROUGH_PATTERN,
      ITALIC_PATTERN,
      ITALIC_UNDERSCORE_PATTERN,
      UNDERLINE_PATTERN,
    ].join("|"),
    "gu",
  );
}

function needsInlineMarkup(text: string): boolean {
  return (
    text.includes("[") ||
    text.includes("*") ||
    text.includes("_") ||
    text.includes("~")
  );
}

function inlineTokenToHtml(tok: string): string {
  const link = MD_LINK_RE.exec(tok);
  if (link) {
    return `<a href="${escapeHtml(link[2] ?? "")}">${escapeHtml(link[1] ?? "")}</a>`;
  }
  const markerLen = emphasisMarkerLen(tok);
  if (markerLen === 0) return escapeHtml(tok);
  const interior = escapeHtml(tok.slice(markerLen, tok.length - markerLen));
  const marker = tok.slice(0, markerLen);
  if (marker === "**") return `<b>${interior}</b>`;
  if (marker === "~~") return `<s>${interior}</s>`;
  if (marker === "~") return `<u>${interior}</u>`;
  // `*` and the render-only `_` alias both paste as italic.
  return `<i>${interior}</i>`;
}

function inlineTokenToRtf(tok: string): string {
  const link = MD_LINK_RE.exec(tok);
  if (link) {
    const label = link[1] ?? "";
    const url = link[2] ?? "";
    return (
      `{\\field{\\*\\fldinst HYPERLINK "${escapeRtf(url)}"}` +
      `{\\fldrslt ${escapeRtf(label)}}}`
    );
  }
  const markerLen = emphasisMarkerLen(tok);
  if (markerLen === 0) return escapeRtf(tok);
  const interior = escapeRtf(tok.slice(markerLen, tok.length - markerLen));
  const marker = tok.slice(0, markerLen);
  if (marker === "**") return `{\\b ${interior}}`;
  if (marker === "~~") return `{\\strike ${interior}}`;
  if (marker === "~") return `{\\ul ${interior}}`;
  return `{\\i ${interior}}`;
}

function scanInline(
  text: string,
  emitToken: (tok: string) => string,
  emitPlain: (s: string) => string,
): string {
  if (!needsInlineMarkup(text)) return emitPlain(text);
  const re = inlineTokenRegex();
  let out = "";
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out += emitPlain(text.slice(last, m.index));
    out += emitToken(m[0]);
    last = re.lastIndex;
  }
  if (last < text.length) out += emitPlain(text.slice(last));
  return out;
}

/**
 * Turn a markdown source slice into an inline HTML fragment. Link tokens become
 * `<a href="…">label</a>`; emphasis becomes `<b>`/`<i>`/`<s>`/`<u>`; everything
 * else is escaped plain text.
 */
export function markdownLinksToHtml(text: string): string {
  return scanInline(text, inlineTokenToHtml, escapeHtml);
}

function imgTag(img: OutlineClipboardImage): string {
  const ct = /^image\/(png|jpeg|gif|webp|avif)$/.test(img.contentType)
    ? img.contentType
    : "image/png";
  let tag = `<img src="data:${ct};base64,${img.data}"`;
  if (img.width > 0) tag += ` width="${img.width}"`;
  if (img.height > 0) tag += ` height="${img.height}"`;
  tag += ">";
  return tag;
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
 * anchors and emphasis. Multi-line outline exports become `<br>`-joined lines so
 * bullet markers stay visible as text while links/bold stay rich. When `outline`
 * carries image bytes, `[image]` placeholders are replaced with data-URI `<img>`
 * tags so Word / Docs paste real pictures (ADR 0061).
 */
export function markdownToClipboardHtml(
  md: string,
  outline?: OutlineClipboardPayload | null,
): string {
  const normalized = md.replace(/\r\n?/g, "\n");
  const slotImages = new Map<number, OutlineClipboardImage[]>();
  if (outline) {
    for (const slot of outline.images) {
      if (slot.items.length) slotImages.set(slot.slot, slot.items);
    }
  }
  const lines = normalized.split("\n");
  const parts: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const hasSlotImages = slotImages.has(i);
    const line = hasSlotImages ? raw.replace(IMAGE_PLACEHOLDER_RE, "") : raw;
    let html = markdownLinksToHtml(line);
    const imgs = slotImages.get(i);
    if (imgs) {
      for (const img of imgs) html += `<br>${imgTag(img)}`;
    }
    parts.push(html);
  }
  return wrapClipboardHtml(parts.join("<br>"));
}

/**
 * Markdown source → RTF with HYPERLINK field codes and emphasis runs. Word
 * (desktop) prefers RTF over HTML when both are on the clipboard; without it,
 * paste often falls back to the markdown text/plain and the link/bold is lost.
 */
export function markdownLinksToRtf(text: string): string {
  const normalized = text.replace(/\r\n?/g, "\n");
  let body = "";
  const lines = normalized.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (i > 0) body += "\\line ";
    body += scanInline(lines[i]!, inlineTokenToRtf, escapeRtf);
  }
  return `{\\rtf1\\ansi\\deff0 ${body}}`;
}

/**
 * Write markdown to the system clipboard as text/plain + text/html (+ text/rtf
 * when ClipboardItem accepts it and no images are embedded). Used by node
 * multi-select and menu "Copy as Markdown" so external apps receive real
 * hyperlinks, bold, and pictures — not `[label](url)` / `**bold**` / `[image]`.
 *
 * Optional `outline` embeds hosted-image bytes in the HTML both as visible
 * data-URI `<img>`s (external apps) and as the hidden in-app marker (ADR 0061).
 * RTF is omitted when images are present: Word prefers RTF and would drop the
 * HTML pictures.
 */
export async function writeMarkdownToClipboard(
  md: string,
  outline?: OutlineClipboardPayload | null,
): Promise<void> {
  const payload = outline ?? { v: 1, images: [] };
  const html = appendOutlinePayloadToHtml(
    markdownToClipboardHtml(md, outline),
    payload,
  );
  const hasImages = outlineClipboardHasImages(outline);
  const rtf = hasImages ? null : markdownLinksToRtf(md);
  if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
    try {
      // Promise-wrapped Blobs: Safari requires them; Chromium accepts them.
      const item: Record<string, Blob | Promise<Blob>> = {
        "text/plain": Promise.resolve(new Blob([md], { type: "text/plain" })),
        "text/html": Promise.resolve(new Blob([html], { type: "text/html" })),
      };
      // text/rtf is optional — some browsers reject unknown MIME on ClipboardItem.
      // Skip when images are present so Word falls through to rich HTML.
      if (rtf) {
        try {
          await navigator.clipboard.write([
            new ClipboardItem({
              ...item,
              "text/rtf": Promise.resolve(
                new Blob([rtf], { type: "text/rtf" }),
              ),
            }),
          ]);
          return;
        } catch {
          // Fall through to HTML+plain without RTF.
        }
      }
      await navigator.clipboard.write([new ClipboardItem(item)]);
      return;
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
