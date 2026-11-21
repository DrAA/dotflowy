/**
 * In-app outline clipboard with hosted images (ADR 0061).
 *
 * External paste still sees markdown + `[image]` placeholders (never a private
 * `/api/media/:id` URL). For Dotflowy↔Dotflowy paste we embed image bytes in
 * `text/html` (paste-event-readable) and re-attach them onto the new node ids.
 */

import type { TreeIndex } from "./tree";

import { childrenOf, trueSourceOf } from "./tree";

export const OUTLINE_CLIPBOARD_VERSION = 1 as const;

/** Hidden marker inside clipboard HTML — paste events can read text/html. */
export const OUTLINE_HTML_MARKER_RE =
  /<!--aaflowy-outline:([A-Za-z0-9+/=]+)-->/;

export type OutlineClipboardImage = {
  contentType: string;
  width: number;
  height: number;
  /** Standard base64 (not base64url). */
  data: string;
};

export type OutlineClipboardSlot = {
  /** DFS index matching outlineToMarkdown / paste plan target ids. */
  slot: number;
  items: OutlineClipboardImage[];
};

export type OutlineClipboardPayload = {
  v: typeof OUTLINE_CLIPBOARD_VERSION;
  images: OutlineClipboardSlot[];
};

/** Soft cap so a huge photo dump does not blow the system clipboard. */
export const OUTLINE_CLIPBOARD_MAX_BYTES = 8 * 1024 * 1024;

/** Strip export placeholders so paste does not leave `[image]` in the text. */
export function stripImagePlaceholders(md: string): string {
  return md.replace(/ \[image(?: ×\d+)?\]/g, "");
}

/**
 * Content-node ids in the same DFS order `outlineToMarkdown` emits lines
 * (mirrors flatten to their source — ADR 0022 / 0044).
 */
export function outlineClipboardContentIds(
  index: TreeIndex,
  rootIds: readonly string[],
): string[] {
  const out: string[] = [];
  const walk = (id: string, path: Set<string>) => {
    const node = index.byId.get(id);
    if (!node) return;
    const contentId = trueSourceOf(index, id);
    out.push(contentId);
    if (path.has(contentId)) return;
    path.add(contentId);
    for (const child of childrenOf(index, contentId)) {
      walk(child.id, path);
    }
    path.delete(contentId);
  };
  for (const id of rootIds) walk(id, new Set());
  return out;
}

/** Target node ids after a structural paste: slot 0 = anchor, then inserts. */
export function outlinePasteTargetIds(
  anchorId: string,
  insertIds: readonly string[],
): string[] {
  return [anchorId, ...insertIds];
}

export function encodeOutlineClipboardPayload(
  payload: OutlineClipboardPayload,
): string {
  const json = JSON.stringify(payload);
  // UTF-8 safe base64 for the HTML comment.
  const bytes = new TextEncoder().encode(json);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin);
}

export function decodeOutlineClipboardPayload(
  encoded: string,
): OutlineClipboardPayload | null {
  try {
    const bin = atob(encoded);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const json = new TextDecoder().decode(bytes);
    const raw = JSON.parse(json) as Partial<OutlineClipboardPayload>;
    if (raw.v !== 1 || !Array.isArray(raw.images)) return null;
    const images: OutlineClipboardSlot[] = [];
    for (const slot of raw.images) {
      if (
        !slot ||
        typeof slot.slot !== "number" ||
        !Array.isArray(slot.items)
      ) {
        continue;
      }
      const items: OutlineClipboardImage[] = [];
      for (const item of slot.items) {
        if (
          !item ||
          typeof item.contentType !== "string" ||
          typeof item.data !== "string" ||
          typeof item.width !== "number" ||
          typeof item.height !== "number"
        ) {
          continue;
        }
        items.push({
          contentType: item.contentType,
          width: item.width,
          height: item.height,
          data: item.data,
        });
      }
      if (items.length) images.push({ slot: slot.slot, items });
    }
    return { v: 1, images };
  } catch {
    return null;
  }
}

/** Pull the in-app image payload from a paste event's clipboardData. */
export function readOutlineClipboardPayload(
  cd: DataTransfer,
): OutlineClipboardPayload | null {
  const html = cd.getData("text/html");
  if (!html) return null;
  const m = OUTLINE_HTML_MARKER_RE.exec(html);
  if (!m?.[1]) return null;
  return decodeOutlineClipboardPayload(m[1]);
}

export function outlineClipboardHasImages(
  payload: OutlineClipboardPayload | null | undefined,
): boolean {
  return !!payload?.images.some((s) => s.items.length > 0);
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin);
}

export function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function appendOutlinePayloadToHtml(
  html: string,
  payload: OutlineClipboardPayload,
): string {
  if (!outlineClipboardHasImages(payload)) return html;
  const marker = `<!--aaflowy-outline:${encodeOutlineClipboardPayload(payload)}-->`;
  // Prefer inside the fragment so Word/Docs still see Start/End markers.
  if (html.includes("<!--EndFragment-->")) {
    return html.replace("<!--EndFragment-->", `${marker}<!--EndFragment-->`);
  }
  return html + marker;
}
