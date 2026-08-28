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
import { queryClient } from "./query-client";
import { trueSourceOf } from "./tree";
import { getTreeIndex, subscribeTree } from "./tree-store";

const KV = "media";

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
      await kvDelete(KV, toKvKeys(transaction));
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
    for (const row of mediaCollection.toArray) {
      if (!keep.has(row.id)) mediaCollection.delete(row.id);
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

function gcOrphans(): void {
  if (restoring) return;
  const index = getTreeIndex();
  // Empty means "not loaded yet" or a snapshot truncate in flight — never a
  // cue to drop every attachment. A truly empty outline GCs on the next insert.
  if (index.byId.size === 0) return;
  for (const row of mediaCollection.toArray) {
    if (!index.byId.has(row.nodeId)) mediaCollection.delete(row.id);
  }
}

function ensureStarted(): void {
  if (started || typeof window === "undefined") return;
  started = true;
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
  capture(ctx.tree, nodeId);
  // Kick off the byte copy before this handler returns so clipboard Files
  // aren't detached after the paste/drop event.
  const pending: PendingImage[] = images.map((preview) => ({
    preview,
    held: retainFileBytes(preview),
  }));
  void uploadAll(pending, contentId);
  return true;
}

async function uploadAll(
  files: PendingImage[],
  contentId: string,
): Promise<void> {
  for (const { preview, held } of files) {
    const tempId = crypto.randomUUID();
    const url = URL.createObjectURL(preview);
    const { width, height } = await measureImage(preview);
    addOverlay({ tempId, nodeId: contentId, url, width, height });
    try {
      const file = await held;
      const row = await postMedia(file, contentId, width, height);
      mediaCollection.insert(row);
    } catch (err) {
      const msg =
        err instanceof QuotaError
          ? "Image is too large for your plan."
          : "Couldn't attach that image.";
      toast.error(msg);
    } finally {
      removeOverlay(tempId);
    }
  }
}

class QuotaError extends Error {
  constructor() {
    super("quota");
    this.name = "QuotaError";
  }
}

async function postMedia(
  file: File,
  nodeId: string,
  width: number,
  height: number,
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
    },
    body: file,
  });
  if (res.status === 413) throw new QuotaError();
  if (!res.ok) throw new Error(`upload ${res.status}`);
  return (await res.json()) as MediaRow;
}

/** Detach one attachment (kv row only; R2 stays for undo). */
export function detachMedia(id: string, ctx: PluginContext): void {
  const row = mediaCollection.toArray.find((r) => r.id === id);
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
