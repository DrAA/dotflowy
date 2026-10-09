import { queryCollectionOptions } from "@tanstack/query-db-collection";
import { createCollection } from "@tanstack/react-db";
import { Schema } from "effect";
import { useSyncExternalStore } from "react";
import { toast } from "sonner";

import type { PluginContext } from "../plugins/types";

import { isLocalDataEnabled } from "./flags";
import { capture, registerHistoryExtra } from "./history";
import { kvDelete, kvFetch, kvPut, toKvKeys, toKvRows } from "./kv-api";
import {
  hydrateLocalMediaUrls,
  localMediaObjectUrl,
  putLocalBlob,
} from "./local-store";
import {
  bindMediaSnapshot,
  isMediaGcSuppressed,
  mediaRowsToReapply,
  type MediaSnapshotRow,
} from "./media-snapshot";
import { queryClient } from "./query-client";
import { trueSourceOf } from "./tree";
import { getTreeIndex, subscribeTree } from "./tree-store";

const KV = "media";

/** Structured client logs for paste/upload/GC forensics (Workers Logs / DevTools). */
function mediaLog(
  level: "info" | "warn" | "error",
  event: string,
  data: Record<string, unknown>,
): void {
  const line = `[media] ${event}`;
  if (level === "error") console.error(line, data);
  else if (level === "warn") console.warn(line, data);
  else console.info(line, data);
}

function fileMeta(file: File): { name: string; type: string; size: number } {
  return { name: file.name, type: file.type, size: file.size };
}

const mediaSchema = Schema.Struct({
  id: Schema.String,
  nodeId: Schema.String,
  contentType: Schema.String,
  bytes: Schema.Number,
  width: Schema.Number,
  height: Schema.Number,
  createdAt: Schema.Number,
});

export type MediaRow = Schema.Schema.Type<typeof mediaSchema>;

export const mediaCollection = createCollection(
  queryCollectionOptions({
    id: "media",
    queryKey: ["kv", KV],
    queryClient,
    queryFn: () => kvFetch<MediaRow>(KV),
    getKey: (row: MediaRow) => row.id,
    schema: Schema.toStandardSchemaV1(mediaSchema),
    onInsert: async ({ transaction }) => {
      await kvPut(KV, toKvRows(transaction));
      return { refetch: false };
    },
    onUpdate: async ({ transaction }) => {
      await kvPut(KV, toKvRows(transaction));
      return { refetch: false };
    },
    onDelete: async ({ transaction }) => {
      const keys = toKvKeys(transaction);
      mediaLog("warn", "kv.delete", {
        count: keys.length,
        ids: keys,
        via: "collection.onDelete",
      });
      await kvDelete(KV, keys);
      return { refetch: false };
    },
  }),
);

const ACCEPT = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/avif",
]);

export function isAttachableImage(file: File): boolean {
  if (ACCEPT.has(file.type)) return true;
  const name = file.name.toLowerCase();
  return (
    file.type === "" &&
    (name.endsWith(".png") ||
      name.endsWith(".jpg") ||
      name.endsWith(".jpeg") ||
      name.endsWith(".gif") ||
      name.endsWith(".webp") ||
      name.endsWith(".avif"))
  );
}

export type MediaOverlay = {
  tempId: string;
  nodeId: string;
  url: string;
  width: number;
  height: number;
};

let overlays: MediaOverlay[] = [];
const overlayListeners = new Set<() => void>();

function emitOverlays(): void {
  for (const l of overlayListeners) l();
}

function addOverlay(row: MediaOverlay): void {
  overlays = [...overlays, row];
  emitOverlays();
}

function removeOverlay(tempId: string): void {
  const hit = overlays.find((o) => o.tempId === tempId);
  if (hit) URL.revokeObjectURL(hit.url);
  overlays = overlays.filter((o) => o.tempId !== tempId);
  emitOverlays();
}

const EMPTY_ROWS: MediaRow[] = [];
let rows: MediaRow[] = EMPTY_ROWS;
const listeners = new Set<() => void>();
let started = false;
let restoring = false;

function rebuild(): void {
  // Slice so useSyncExternalStore sees a new snapshot when blob URLs hydrate
  // without the kv rows changing (same toArray identity would skip the paint
  // and leave <img src=""> after reload).
  rows = mediaCollection.toArray.slice();
  for (const l of listeners) l();
}

function restoreMediaSnapshot(data: unknown): void {
  restoring = true;
  try {
    const next = Array.isArray(data) ? (data as MediaRow[]) : [];
    const keep = new Set(next.map((r) => r.id));
    const removed: string[] = [];
    for (const row of mediaCollection.toArray) {
      if (keep.has(row.id)) continue;
      removed.push(row.id);
      mediaCollection.delete(row.id);
    }
    if (removed.length > 0) {
      mediaLog("warn", "history.restore.drop", {
        keep: next.length,
        removed,
      });
    }
    for (const row of next) {
      if (mediaCollection.has(row.id)) {
        mediaCollection.update(row.id, (draft) => Object.assign(draft, row));
      } else {
        mediaCollection.insert({ ...row });
      }
    }
  } finally {
    restoring = false;
  }
}

/**
 * How long a freshly uploaded attachment is immune to tree-driven orphan GC.
 * Enter / mid-session snapshot can briefly omit a live node from `byId`;
 * persist-deleting in that window left R2 orphans and empty image bullets.
 * Real node deletes still drop media on the DO (`deleteNodes`); this only
 * delays the redundant client pass.
 */
export const MEDIA_GC_GRACE_MS = 120_000;

/** Rows whose content node is absent and older than the post-upload grace. */
export function mediaOrphansToDelete(
  rows: readonly Pick<MediaRow, "id" | "nodeId" | "createdAt">[],
  presentNodeIds: ReadonlySet<string>,
  now: number,
  graceMs: number = MEDIA_GC_GRACE_MS,
): { id: string; nodeId: string; ageMs: number }[] {
  const drop: { id: string; nodeId: string; ageMs: number }[] = [];
  for (const row of rows) {
    if (presentNodeIds.has(row.nodeId)) continue;
    const ageMs = now - row.createdAt;
    // Negative age = client clock behind server createdAt; still in grace.
    if (ageMs < graceMs) continue;
    drop.push({ id: row.id, nodeId: row.nodeId, ageMs });
  }
  return drop;
}

function gcOrphans(): void {
  if (restoring || isMediaGcSuppressed()) return;
  const index = getTreeIndex();
  // Empty means "not loaded yet" or a snapshot truncate in flight — never a
  // cue to drop every attachment. A truly empty outline GCs on the next insert.
  if (index.byId.size === 0) return;
  const now = Date.now();
  const present = new Set(index.byId.keys());
  const drop = mediaOrphansToDelete(mediaCollection.toArray, present, now);
  const dropIds = new Set(drop.map((d) => d.id));
  const held = mediaCollection.toArray
    .filter((row) => !present.has(row.nodeId) && !dropIds.has(row.id))
    .map((r) => ({
      id: r.id,
      nodeId: r.nodeId,
      ageMs: now - r.createdAt,
    }));
  if (held.length > 0) {
    mediaLog("info", "gc.orphans.grace", {
      byIdSize: index.byId.size,
      skipped: held.length,
      graceMs: MEDIA_GC_GRACE_MS,
      held,
    });
  }
  if (drop.length === 0) return;
  mediaLog("warn", "gc.orphans", {
    byIdSize: index.byId.size,
    dropCount: drop.length,
    drop,
  });
  for (const row of drop) mediaCollection.delete(row.id);
}

function captureMediaRows(): MediaSnapshotRow[] {
  return mediaCollection.toArray.map((r) => ({ ...r }));
}

function reapplyMediaRows(stashed: readonly MediaSnapshotRow[]): void {
  const index = getTreeIndex();
  const presentNodeIds = new Set(index.byId.keys());
  const heldMediaIds = new Set(mediaCollection.toArray.map((r) => r.id));
  const missing = mediaRowsToReapply(stashed, presentNodeIds, heldMediaIds);
  if (missing.length > 0) {
    mediaLog("info", "snapshot.reapply", {
      stashed: stashed.length,
      missing: missing.length,
      ids: missing.map((r) => r.id),
      nodeIds: missing.map((r) => r.nodeId),
    });
  }
  for (const row of missing) {
    mediaCollection.insert({ ...row });
  }
}

function bindSnapshotHandlers(): void {
  bindMediaSnapshot({
    capture: captureMediaRows,
    reapply: reapplyMediaRows,
  });
}

bindSnapshotHandlers();

function ensureStarted(): void {
  if (started || typeof window === "undefined") return;
  started = true;
  // Re-bind in case a unit test swapped the media-snapshot handlers.
  bindSnapshotHandlers();
  mediaCollection.subscribeChanges(() => rebuild(), {
    includeInitialState: true,
  });
  registerHistoryExtra({
    snapshot: () => mediaCollection.toArray.map((r) => ({ ...r })),
    restore: restoreMediaSnapshot,
  });
  subscribeTree(() => gcOrphans());
}

/** Kick the kv fetch + history extra + orphan GC. Idempotent. */
export function startMedia(): void {
  ensureStarted();
  if (isLocalDataEnabled()) {
    void hydrateLocalMediaUrls().then(() => rebuild());
  }
}

/** Blob URL in local-data mode, otherwise the Worker media route. */
export function mediaUrl(id: string): string {
  if (isLocalDataEnabled()) return localMediaObjectUrl(id) ?? "";
  return `/api/media/${id}`;
}

function subscribe(cb: () => void): () => void {
  ensureStarted();
  listeners.add(cb);
  overlayListeners.add(cb);
  return () => {
    listeners.delete(cb);
    overlayListeners.delete(cb);
  };
}

function getRows(): MediaRow[] {
  ensureStarted();
  return rows;
}

export function useMediaRows(): MediaRow[] {
  return useSyncExternalStore(subscribe, getRows, () => EMPTY_ROWS);
}

export function useMediaOverlays(): MediaOverlay[] {
  return useSyncExternalStore(
    subscribe,
    () => overlays,
    (): MediaOverlay[] => [],
  );
}

export function mediaForNode(
  contentId: string,
  all: readonly MediaRow[],
): MediaRow[] {
  return all.filter((r) => r.nodeId === contentId);
}

export function nodeHasImage(
  contentId: string,
  all: readonly MediaRow[],
): boolean {
  return all.some((r) => r.nodeId === contentId);
}

export function imageCountsByNode(): Map<string, number> {
  ensureStarted();
  const map = new Map<string, number>();
  for (const row of mediaCollection.toArray) {
    map.set(row.nodeId, (map.get(row.nodeId) ?? 0) + 1);
  }
  return map;
}

/** Live rows for non-React callers (filter predicates). Starts the collection. */
export function getMediaRows(): MediaRow[] {
  ensureStarted();
  return mediaCollection.toArray;
}

async function measureImage(
  file: File,
): Promise<{ width: number; height: number }> {
  try {
    const bmp = await createImageBitmap(file);
    const size = { width: bmp.width, height: bmp.height };
    bmp.close();
    return size;
  } catch {
    return { width: 0, height: 0 };
  }
}

/**
 * Copy bytes out of a paste/drop `File` in this turn. Clipboard DataTransfer
 * files are only guaranteed readable if the read starts during the event;
 * IndexedDB also structured-clones some clipboard Files into empty blobs, so
 * the overlay looks fine until reload.
 */
export async function retainFileBytes(file: File): Promise<File> {
  const bytes = await file.arrayBuffer();
  return new File([bytes], file.name, {
    type: file.type || "application/octet-stream",
    lastModified: file.lastModified,
  });
}

type PendingImage = {
  preview: File;
  held: Promise<File>;
};

/**
 * Claim image files, capture undo, upload, insert kv rows. Returns false when
 * none of the files are attachable images (so paste can fall through to text).
 */
export function attachImages(
  files: File[],
  nodeId: string,
  ctx: PluginContext,
): boolean {
  const images = files.filter(isAttachableImage);
  if (images.length === 0) return false;
  const contentId = trueSourceOf(ctx.tree, nodeId);
  const batchId = crypto.randomUUID();
  mediaLog("info", "attach.start", {
    batchId,
    focusNodeId: nodeId,
    contentId,
    fileCount: images.length,
    skipped: files.length - images.length,
    files: images.map(fileMeta),
  });
  capture(ctx.tree, nodeId);
  // Kick off the byte copy before this handler returns so clipboard Files
  // aren't detached after the paste/drop event.
  const pending: PendingImage[] = images.map((preview) => ({
    preview,
    held: retainFileBytes(preview),
  }));
  void uploadAll(pending, contentId, batchId);
  return true;
}

async function uploadAll(
  files: PendingImage[],
  contentId: string,
  batchId: string,
): Promise<void> {
  for (let i = 0; i < files.length; i++) {
    const { preview, held } = files[i]!;
    const tempId = crypto.randomUUID();
    const started = Date.now();
    const url = URL.createObjectURL(preview);
    const { width, height } = await measureImage(preview);
    addOverlay({ tempId, nodeId: contentId, url, width, height });
    try {
      const file = await held;
      if (file.size === 0) {
        mediaLog("warn", "upload.empty-bytes", {
          batchId,
          index: i,
          contentId,
          preview: fileMeta(preview),
          held: fileMeta(file),
        });
      } else if (file.size !== preview.size) {
        mediaLog("warn", "upload.size-mismatch", {
          batchId,
          index: i,
          contentId,
          previewSize: preview.size,
          heldSize: file.size,
        });
      }
      const row = await postMedia(file, contentId, width, height, batchId, i);
      mediaCollection.insert(row);
      mediaLog("info", "upload.ok", {
        batchId,
        index: i,
        mediaId: row.id,
        nodeId: row.nodeId,
        bytes: row.bytes,
        width: row.width,
        height: row.height,
        ms: Date.now() - started,
      });
    } catch (err) {
      mediaLog("error", "upload.fail", {
        batchId,
        index: i,
        contentId,
        preview: fileMeta(preview),
        ms: Date.now() - started,
        error: err instanceof Error ? err.message : String(err),
      });
      toast.error("Couldn't attach that image.");
    } finally {
      removeOverlay(tempId);
    }
  }
}

async function postMedia(
  file: File,
  nodeId: string,
  width: number,
  height: number,
  batchId?: string,
  index?: number,
): Promise<MediaRow> {
  if (isLocalDataEnabled()) {
    const id = crypto.randomUUID();
    await putLocalBlob(id, file);
    return {
      id,
      nodeId,
      contentType: file.type || "application/octet-stream",
      bytes: file.size,
      width,
      height,
      createdAt: Date.now(),
    };
  }
  const res = await fetch(`/api/media?nodeId=${encodeURIComponent(nodeId)}`, {
    method: "POST",
    credentials: "same-origin",
    headers: {
      "content-type": file.type || "application/octet-stream",
      "x-image-width": String(width),
      "x-image-height": String(height),
      ...(batchId ? { "x-media-batch-id": batchId } : {}),
      ...(index != null ? { "x-media-batch-index": String(index) } : {}),
    },
    body: file,
  });
  if (!res.ok) {
    let body = "";
    try {
      body = (await res.text()).slice(0, 200);
    } catch {
      /* ignore */
    }
    throw new Error(`upload ${res.status}${body ? `: ${body}` : ""}`);
  }
  return (await res.json()) as MediaRow;
}

/** Detach one attachment (kv row only; R2 stays for undo). */
export function detachMedia(id: string, ctx: PluginContext): void {
  const row = mediaCollection.toArray.find((r) => r.id === id);
  mediaLog("info", "detach", {
    mediaId: id,
    nodeId: row?.nodeId ?? null,
  });
  capture(ctx.tree, row?.nodeId ?? null);
  if (mediaCollection.has(id)) mediaCollection.delete(id);
}

/** Open a hidden file picker and attach the chosen images. */
export function pickAndAttachImages(nodeId: string, ctx: PluginContext): void {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/jpeg,image/png,image/gif,image/webp,image/avif";
  input.multiple = true;
  input.addEventListener("change", () => {
    const files = [...(input.files ?? [])];
    if (files.length) attachImages(files, nodeId, ctx);
    input.remove();
  });
  input.click();
}
