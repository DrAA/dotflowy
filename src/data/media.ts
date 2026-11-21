import { queryCollectionOptions } from "@tanstack/query-db-collection";
import { createCollection } from "@tanstack/react-db";
import { Schema } from "effect";
import { useSyncExternalStore } from "react";
import { toast } from "sonner";

import type { PluginContext } from "../plugins/types";

import { isLocalDataEnabled, isSealedOutlineEnabled } from "./flags";
import { capture, registerHistoryExtra } from "./history";
import { kvDelete, kvFetch, kvPut, toKvKeys, toKvRows } from "./kv-api";
import {
  hydrateLocalMediaUrls,
  localMediaObjectUrl,
  putLocalBlob,
} from "./local-store";
import { bindMediaLive, type RemoteMediaRow } from "./media-live";
import {
  bindMediaSnapshot,
  isMediaGcSuppressed,
  mediaRowsToReapply,
  type MediaSnapshotRow,
} from "./media-snapshot";
import {
  base64ToBytes,
  bytesToBase64,
  OUTLINE_CLIPBOARD_MAX_BYTES,
  outlineClipboardContentIds,
  type OutlineClipboardImage,
  type OutlineClipboardPayload,
  type OutlineClipboardSlot,
} from "./outline-clipboard";
import { queryClient } from "./query-client";
import { sealMediaBytes, unsealMediaBytes } from "./seal/media";
import { getSealDek } from "./seal/session";
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
  sealed: Schema.optional(Schema.Boolean),
});

const sealedObjectUrls = new Map<string, string>();
const sealedInflight = new Set<string>();

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
      const allowLiveNode = mediaDeletePermitsLiveNode(
        keys,
        liveNodeMediaDeletes,
      );
      for (const key of keys) liveNodeMediaDeletes.delete(key);
      mediaLog("warn", "kv.delete", {
        count: keys.length,
        ids: keys,
        allowLiveNode,
        via: "collection.onDelete",
      });
      await kvDelete(
        KV,
        keys,
        allowLiveNode ? { allowLiveNode: true } : undefined,
      );
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
  if (inferImageContentType(file) != null) return true;
  // Clipboard bitmaps sometimes have no MIME and no extension; sniff later.
  return file.type === "" && file.size > 32;
}

/**
 * MIME for upload. Clipboard pastes often arrive with an empty `File.type`
 * (Firefox/Safari); sealed POST rejects anything outside ALLOWED_IMAGE_TYPES,
 * so we must not send `application/octet-stream`.
 */
export function inferImageContentType(file: File): string | null {
  if (ACCEPT.has(file.type)) return file.type;
  const name = file.name.toLowerCase();
  if (name.endsWith(".png")) return "image/png";
  if (name.endsWith(".jpg") || name.endsWith(".jpeg")) return "image/jpeg";
  if (name.endsWith(".gif")) return "image/gif";
  if (name.endsWith(".webp")) return "image/webp";
  if (name.endsWith(".avif")) return "image/avif";
  // Screenshot / OS paste often names the file "image.png" or bare "image".
  if (file.type === "" && (name === "image" || name.startsWith("image."))) {
    return "image/png";
  }
  return null;
}

/** Magic-byte sniff (same signatures as worker/media.ts) for typeless pastes. */
export function sniffImageContentType(bytes: Uint8Array): string | null {
  if (bytes.length < 12) return null;
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return "image/png";
  }
  if (
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38
  ) {
    return "image/gif";
  }
  if (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  // ftyp....avif / avis
  if (
    bytes[4] === 0x66 &&
    bytes[5] === 0x74 &&
    bytes[6] === 0x79 &&
    bytes[7] === 0x70
  ) {
    const brand = String.fromCharCode(
      bytes[8]!,
      bytes[9]!,
      bytes[10]!,
      bytes[11]!,
    );
    if (brand === "avif" || brand === "avis") return "image/avif";
  }
  return null;
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

/**
 * Media ids the user (or undo / backup restore) asked to remove even though
 * the bullet still exists. Tree-absence GC must not be in this set: the DO
 * ignores a hosted delete of those rows. See `mediaDeleteKeys`.
 */
const liveNodeMediaDeletes = new Set<string>();

/** Ids whose next kv delete is an intentional detach, not orphan GC. */
export function permitLiveNodeMediaDelete(ids: readonly string[]): void {
  for (const id of ids) liveNodeMediaDeletes.add(id);
}

/** True when every key in this delete was marked with `permitLiveNodeMediaDelete`. */
export function mediaDeletePermitsLiveNode(
  keys: readonly string[],
  permitted: ReadonlySet<string>,
): boolean {
  return keys.length > 0 && keys.every((key) => permitted.has(key));
}

function rebuild(): void {
  // Slice so useSyncExternalStore sees a new snapshot when blob URLs hydrate
  // without the kv rows changing (same toArray identity would skip the paint
  // and leave <img src=""> after reload).
  rows = mediaCollection.toArray.slice();
  for (const l of listeners) l();
}

/** Cache a plaintext object URL and force a media re-render (ADR 0063). */
function cacheSealedObjectUrl(id: string, url: string): void {
  const prev = sealedObjectUrls.get(id);
  if (prev) URL.revokeObjectURL(prev);
  sealedObjectUrls.set(id, url);
  // Must rebuild — notifying listeners alone keeps the same `rows` reference
  // and useSyncExternalStore skips the paint (blank <img> after sealed paste
  // when the live echo inserted the row before this cache landed).
  rebuild();
}

function restoreMediaSnapshot(data: unknown): void {
  restoring = true;
  try {
    const next = Array.isArray(data) ? (data as MediaRow[]) : [];
    const keep = new Set(next.map((r) => r.id));
    const removed: string[] = [];
    for (const row of mediaCollection.toArray) {
      if (!keep.has(row.id)) removed.push(row.id);
    }
    // Undo drops attachments on bullets that still exist. Mark them before
    // delete so the DO does not treat the request as tree-absence GC.
    permitLiveNodeMediaDelete(removed);
    for (const id of removed) mediaCollection.delete(id);
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
 * How long a freshly uploaded attachment is immune to local-data orphan GC.
 * Hosted mode does not absence-delete at all (the DO `deleteNodes` path does).
 * Local-data mode has one tree and no DO, so this grace still covers a brief
 * gap where `byId` is incomplete right after upload.
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
  // Hosted sync lags. Another browser refetches media on focus before resume
  // inserts bullets created elsewhere; those node ids are absent, not deleted.
  // Persist-deleting there erased the kv pointer in every browser (R2 kept the
  // bytes). The DO `deleteNodes` path removes attachments when a node is
  // actually removed. Local-data mode has no DO and a single complete tree.
  if (!isLocalDataEnabled()) return;
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

function applyRemoteMediaRows(rows: readonly RemoteMediaRow[]): void {
  // writeUpsert lands in the synced store and does not PUT back to the server.
  // A local upload that already inserted the row is an update of the same id.
  const sealedMode = isSealedOutlineEnabled();
  for (const row of rows) {
    try {
      const prev = mediaCollection.toArray.find((r) => r.id === row.id);
      // Live frames used to omit `sealed`; in sealed mode every attachment is
      // ciphertext after migrate, so mark + decrypt even when the poke lacks it.
      const sealed = sealedMode || row.sealed === true || prev?.sealed === true;
      mediaCollection.utils.writeUpsert({
        ...row,
        ...(sealed ? { sealed: true } : {}),
      });
      if (sealedMode) void ensureSealedObjectUrl(row.id);
    } catch (err) {
      mediaLog("warn", "remote.upsert.skip", {
        mediaId: row.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  // writeUpsert can be quiet to useSyncExternalStore; force a paint so the
  // peer shows the new row (and later the blob URL) without a full reload.
  rebuild();
}

function applyRemoteMediaDeletes(ids: readonly string[]): void {
  const present = ids.filter((id) => mediaCollection.has(id));
  if (present.length === 0) return;
  try {
    mediaCollection.utils.writeDelete(present);
  } catch (err) {
    mediaLog("warn", "remote.delete.skip", {
      ids: present,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function bindLiveHandlers(): void {
  bindMediaLive({
    upsert: applyRemoteMediaRows,
    remove: applyRemoteMediaDeletes,
  });
}

bindSnapshotHandlers();
bindLiveHandlers();

function ensureStarted(): void {
  if (started || typeof window === "undefined") return;
  started = true;
  // Re-bind in case a unit test swapped the media-snapshot handlers.
  bindSnapshotHandlers();
  bindLiveHandlers();
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
  } else {
    hydrateSealedMediaUrls();
  }
}

/** Blob URL in local-data / sealed modes, otherwise the Worker media route. */
export function mediaUrl(id: string): string {
  if (isLocalDataEnabled()) return localMediaObjectUrl(id) ?? "";
  if (isSealedOutlineEnabled()) {
    const cached = sealedObjectUrls.get(id);
    if (cached) return cached;
    // Kick async decrypt; callers re-render via media collection / overlays.
    void ensureSealedObjectUrl(id);
    return sealedObjectUrls.get(id) ?? "";
  }
  return `/api/media/${id}`;
}

async function ensureSealedObjectUrl(id: string): Promise<void> {
  if (sealedObjectUrls.has(id) || !getSealDek() || sealedInflight.has(id)) {
    return;
  }
  sealedInflight.add(id);
  try {
    const res = await fetch(`/api/media/${id}`, { credentials: "same-origin" });
    if (!res.ok) return;
    const packed = new Uint8Array(await res.arrayBuffer());
    const row = mediaCollection.toArray.find((r) => r.id === id);
    const headerSealed = res.headers.get("x-seal-envelope") === "1";
    // Sealed accounts always fetch ciphertext after migrate. Fall back to raw
    // bytes only when decrypt fails and the server did not claim an envelope
    // (pre-reseal plaintext leftover).
    const preferUnseal =
      isSealedOutlineEnabled() || row?.sealed === true || headerSealed;
    let plain: Uint8Array<ArrayBuffer>;
    if (preferUnseal) {
      try {
        plain = await unsealMediaBytes(packed);
      } catch (err) {
        if (headerSealed || row?.sealed) throw err;
        const copy = new Uint8Array(packed.byteLength);
        copy.set(packed);
        plain = copy;
      }
    } else {
      const copy = new Uint8Array(packed.byteLength);
      copy.set(packed);
      plain = copy;
    }
    const blob = new Blob([plain], {
      type: row?.contentType || "application/octet-stream",
    });
    const url = URL.createObjectURL(blob);
    if (preferUnseal && row && !row.sealed && mediaCollection.has(id)) {
      mediaCollection.utils.writeUpsert({ ...row, sealed: true });
    }
    cacheSealedObjectUrl(id, url);
  } catch (err) {
    mediaLog("error", "sealed.decrypt-fail", {
      mediaId: id,
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    sealedInflight.delete(id);
  }
}

/** Decrypt sealed attachments after unlock (idempotent). */
export function hydrateSealedMediaUrls(): void {
  if (!isSealedOutlineEnabled() || !getSealDek()) return;
  void resealExistingMedia().finally(() => {
    for (const row of mediaCollection.toArray) {
      void ensureSealedObjectUrl(row.id);
    }
  });
}

let resealRunning = false;

/**
 * One-shot: encrypt plaintext R2 attachments that predate sealing (ADR 0063).
 * Same media id; replaces body via PUT /api/media/:id.
 */
export async function resealExistingMedia(): Promise<void> {
  if (
    resealRunning ||
    !isSealedOutlineEnabled() ||
    !getSealDek() ||
    isLocalDataEnabled()
  ) {
    return;
  }
  // Wait for kv hydrate — unlock often fires before media rows land.
  try {
    await mediaCollection.toArrayWhenReady();
  } catch {
    return;
  }
  const pending = mediaCollection.toArray.filter((r) => !r.sealed);
  if (pending.length === 0) return;
  resealRunning = true;
  let sealed = 0;
  let failed = 0;
  mediaLog("info", "reseal.start", { count: pending.length });
  try {
    for (const row of pending) {
      try {
        const getRes = await fetch(`/api/media/${row.id}`, {
          credentials: "same-origin",
        });
        if (!getRes.ok) {
          failed++;
          continue;
        }
        // Skip if server already marked sealed (other tab raced).
        if (getRes.headers.get("x-seal-envelope") === "1") {
          if (mediaCollection.has(row.id)) {
            mediaCollection.update(row.id, (draft) => {
              draft.sealed = true;
            });
          }
          sealed++;
          continue;
        }
        const plain = new Uint8Array(await getRes.arrayBuffer());
        const packed = await sealMediaBytes(plain);
        const contentType = row.contentType || "application/octet-stream";
        const putRes = await fetch(`/api/media/${row.id}`, {
          method: "PUT",
          credentials: "same-origin",
          headers: {
            "content-type": "application/octet-stream",
            "x-seal-envelope": "1",
            "x-seal-content-type": contentType,
          },
          body: packed,
        });
        if (!putRes.ok) {
          failed++;
          mediaLog("warn", "reseal.put-fail", {
            mediaId: row.id,
            status: putRes.status,
          });
          continue;
        }
        const next = (await putRes.json()) as MediaRow;
        if (mediaCollection.has(row.id)) {
          mediaCollection.update(row.id, (draft) => Object.assign(draft, next));
        } else {
          mediaCollection.utils.writeUpsert(next);
        }
        // Cache plaintext we still hold for immediate display.
        const view = new Uint8Array(plain.byteLength);
        view.set(plain);
        cacheSealedObjectUrl(
          row.id,
          URL.createObjectURL(new Blob([view], { type: contentType })),
        );
        sealed++;
      } catch (err) {
        failed++;
        mediaLog("error", "reseal.one-fail", {
          mediaId: row.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  } finally {
    resealRunning = false;
    mediaLog("info", "reseal.done", { sealed, failed });
    rebuild();
  }
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

async function readMediaPlainBytes(row: MediaRow): Promise<Uint8Array | null> {
  const cached = sealedObjectUrls.get(row.id);
  if (cached) {
    try {
      const res = await fetch(cached);
      if (res.ok) return new Uint8Array(await res.arrayBuffer());
    } catch {
      /* fall through */
    }
  }
  if (isLocalDataEnabled()) {
    const url = localMediaObjectUrl(row.id);
    if (!url) return null;
    try {
      const res = await fetch(url);
      if (!res.ok) return null;
      return new Uint8Array(await res.arrayBuffer());
    } catch {
      return null;
    }
  }
  try {
    const res = await fetch(`/api/media/${row.id}`, {
      credentials: "same-origin",
    });
    if (!res.ok) return null;
    const packed = new Uint8Array(await res.arrayBuffer());
    const headerSealed = res.headers.get("x-seal-envelope") === "1";
    if (row.sealed || headerSealed || isSealedOutlineEnabled()) {
      try {
        return await unsealMediaBytes(packed);
      } catch {
        if (headerSealed || row.sealed) return null;
        return packed;
      }
    }
    return packed;
  } catch {
    return null;
  }
}

/**
 * Build the in-app image payload for a copy of `rootIds` (DFS slot order).
 * Returns null when there are no images or the payload would exceed the cap.
 */
export async function buildOutlineClipboardImages(
  rootIds: readonly string[],
): Promise<OutlineClipboardPayload | null> {
  ensureStarted();
  const index = getTreeIndex();
  const contentIds = outlineClipboardContentIds(index, rootIds);
  const slots: OutlineClipboardSlot[] = [];
  let total = 0;
  for (let slot = 0; slot < contentIds.length; slot++) {
    const contentId = contentIds[slot]!;
    const rows = mediaForNode(contentId, mediaCollection.toArray);
    if (rows.length === 0) continue;
    const items: OutlineClipboardImage[] = [];
    for (const row of rows) {
      const plain = await readMediaPlainBytes(row);
      if (!plain || plain.byteLength === 0) continue;
      total += plain.byteLength;
      if (total > OUTLINE_CLIPBOARD_MAX_BYTES) {
        mediaLog("warn", "outline-clipboard.too-large", {
          roots: rootIds.length,
          bytes: total,
        });
        return null;
      }
      items.push({
        contentType: row.contentType || "application/octet-stream",
        width: row.width,
        height: row.height,
        data: bytesToBase64(plain),
      });
    }
    if (items.length) slots.push({ slot, items });
  }
  if (slots.length === 0) return null;
  return { v: 1, images: slots };
}

/** Re-upload clipboard images onto pasted node ids (slot → target). */
export async function attachOutlineClipboardImages(
  targetIds: readonly string[],
  payload: OutlineClipboardPayload,
): Promise<void> {
  ensureStarted();
  let attached = 0;
  let failed = 0;
  for (const slot of payload.images) {
    const nodeId = targetIds[slot.slot];
    if (!nodeId) continue;
    for (const item of slot.items) {
      try {
        const bytes = base64ToBytes(item.data);
        const ext =
          item.contentType === "image/jpeg"
            ? "jpg"
            : item.contentType === "image/png"
              ? "png"
              : item.contentType === "image/gif"
                ? "gif"
                : item.contentType === "image/webp"
                  ? "webp"
                  : item.contentType === "image/avif"
                    ? "avif"
                    : "bin";
        const file = new File([bytes], `pasted.${ext}`, {
          type: item.contentType,
        });
        const row = await postMedia(file, nodeId, item.width, item.height);
        if (mediaCollection.has(row.id)) {
          mediaCollection.utils.writeUpsert(row);
        } else {
          mediaCollection.insert(row);
        }
        attached++;
      } catch (err) {
        failed++;
        mediaLog("error", "outline-clipboard.attach-fail", {
          slot: slot.slot,
          nodeId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
  if (attached) rebuild();
  if (failed && !attached) {
    toast.error("Couldn't attach the copied images.");
  } else if (failed) {
    toast.error("Some copied images couldn't be attached.");
  }
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
      // The live echo can land before this insert. Merge so we keep `sealed`
      // even if an older peer frame omitted it; a second insert throws.
      if (mediaCollection.has(row.id)) {
        const prev = mediaCollection.toArray.find((r) => r.id === row.id);
        mediaCollection.utils.writeUpsert({
          ...prev,
          ...row,
          ...(prev?.sealed || row.sealed ? { sealed: true } : {}),
        });
      } else {
        mediaCollection.insert(row);
      }
      // Echo may have painted with src="" before the blob URL was cached.
      rebuild();
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
  const sealed = isSealedOutlineEnabled() && !!getSealDek();
  const plainBytes = new Uint8Array(await file.arrayBuffer());
  const contentType =
    inferImageContentType(file) ||
    sniffImageContentType(plainBytes) ||
    file.type ||
    "";
  if (!ACCEPT.has(contentType)) {
    throw new Error(`unsupported image type (${contentType || "unknown"})`);
  }
  let body: BodyInit = file;
  const headers: Record<string, string> = {
    "content-type": sealed ? "application/octet-stream" : contentType,
    "x-image-width": String(width),
    "x-image-height": String(height),
    ...(batchId ? { "x-media-batch-id": batchId } : {}),
    ...(index != null ? { "x-media-batch-index": String(index) } : {}),
  };
  if (sealed) {
    const packed = await sealMediaBytes(plainBytes);
    body = packed;
    headers["x-seal-envelope"] = "1";
    headers["x-seal-content-type"] = contentType;
  } else {
    body = plainBytes;
  }
  const res = await fetch(`/api/media?nodeId=${encodeURIComponent(nodeId)}`, {
    method: "POST",
    credentials: "same-origin",
    headers,
    body,
  });
  if (!res.ok) {
    let errBody = "";
    try {
      errBody = (await res.text()).slice(0, 200);
    } catch {
      /* ignore */
    }
    throw new Error(`upload ${res.status}${errBody ? `: ${errBody}` : ""}`);
  }
  const row = (await res.json()) as MediaRow;
  // Preview from the plaintext file we still hold — skip a decrypt round-trip.
  if (sealed || row.sealed) {
    cacheSealedObjectUrl(row.id, URL.createObjectURL(file));
  }
  return row;
}

/** Detach one attachment (kv row only; R2 stays for undo). */
export function detachMedia(id: string, ctx: PluginContext): void {
  const row = mediaCollection.toArray.find((r) => r.id === id);
  mediaLog("info", "detach", {
    mediaId: id,
    nodeId: row?.nodeId ?? null,
  });
  capture(ctx.tree, row?.nodeId ?? null);
  if (mediaCollection.has(id)) {
    permitLiveNodeMediaDelete([id]);
    mediaCollection.delete(id);
  }
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
