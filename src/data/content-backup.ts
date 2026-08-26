/**
 * Portable whole-outline backup: nodes, kv side-collections, and embedded
 * image bytes in one gzip-compressed JSON file. The operator R2 snapshot
 * (worker/backup.ts) deliberately omits media bytes (ADR 0061); this is the
 * user-facing backup that round-trips hosted images.
 */

import { Schema } from "effect";

import type { MediaRow } from "./media";
import type { Node } from "./schema";
import type { TreeIndex } from "./tree";

import { isLocalDataEnabled, isLunoraSyncEnabled } from "./flags";
import {
  capture,
  drop,
  planRestoreToNodes,
  RESTORE_SLICE_OPS,
} from "./history";
import { kvDelete, kvFetch, kvPut } from "./kv-api";
import { getLiveNodes } from "./live-nodes";
import {
  inferKvKey,
  loadAllLocalBlobs,
  putLocalBlob,
  rememberLocalMediaUrl,
} from "./local-store";
import { classicDailyRowToImport } from "./lunora-migrate-plan";
import { getLunoraOutlineContext } from "./lunora-sync";
import { mediaCollection } from "./media";
import { nodeSchema } from "./schema";
import { runStructural, runStructuralSliced } from "./structural";
import { getTreeIndex } from "./tree-store";

/** Bump when the on-disk backup shape changes. */
export const CONTENT_BACKUP_VERSION = 1;

export const BACKUP_FILE_EXT = ".aaflowy-backup.json.gz";

/** Side-collections included in every backup. */
export const BACKUP_KV_COLLECTIONS = [
  "media",
  "tag-colors",
  "daily-index",
  "saved-queries",
  "changelog",
  "account-prefs",
] as const;

const ContentBackupKvRowSchema = Schema.Struct({
  collection: Schema.String,
  key: Schema.String,
  value: Schema.Unknown,
});

const ContentBackupBlobSchema = Schema.Struct({
  contentType: Schema.String,
  base64: Schema.String,
});

export const ContentBackupSchema = Schema.Struct({
  version: Schema.Literal(CONTENT_BACKUP_VERSION),
  exportedAt: Schema.Number,
  app: Schema.Literal("aaflowy"),
  nodes: Schema.Array(nodeSchema),
  kv: Schema.Array(ContentBackupKvRowSchema),
  blobs: Schema.Record(Schema.String, ContentBackupBlobSchema),
});

export type ContentBackupKvRow = Schema.Schema.Type<
  typeof ContentBackupKvRowSchema
>;
export type ContentBackupBlob = Schema.Schema.Type<
  typeof ContentBackupBlobSchema
>;
export type ContentBackup = Schema.Schema.Type<typeof ContentBackupSchema>;

const decodeBackup = Schema.decodeUnknownSync(ContentBackupSchema);

/** UTC date slug for backup filenames (`YYYY-MM-DD-aaflowy-backup`). */
export function backupDateKey(at = Date.now()): string {
  return new Date(at).toISOString().slice(0, 10);
}

export function backupFilename(at = Date.now()): string {
  return `${backupDateKey(at)}-aaflowy-backup${BACKUP_FILE_EXT}`;
}

/** Base64-encode raw bytes (no data-URL prefix). */
export function encodeBlobBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

/** Decode a base64 blob payload back to bytes. */
export function decodeBlobBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** Validate an already-parsed JSON value as a content backup. */
export function parseContentBackup(data: unknown): ContentBackup {
  return decodeBackup(data);
}

/** Gzip-compress a JSON-serializable value. Browser-only. */
export async function gzipJson(value: unknown): Promise<Uint8Array> {
  const json = JSON.stringify(value);
  const stream = new Blob([json])
    .stream()
    .pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Gunzip bytes and JSON.parse the result. Browser-only. */
export async function gunzipJson(bytes: Uint8Array): Promise<unknown> {
  const stream = new Blob([new Uint8Array(bytes)])
    .stream()
    .pipeThrough(new DecompressionStream("gzip"));
  const text = await new Response(stream).text();
  return JSON.parse(text) as unknown;
}

function mediaRowsFromKv(kv: readonly ContentBackupKvRow[]): MediaRow[] {
  const out: MediaRow[] = [];
  for (const row of kv) {
    if (row.collection !== "media") continue;
    const value = row.value as MediaRow;
    if (typeof value?.id === "string" && typeof value?.nodeId === "string") {
      out.push(value);
    }
  }
  return out;
}

function mediaRowsFromBackup(backup: ContentBackup): MediaRow[] {
  return mediaRowsFromKv(backup.kv);
}

async function fetchMediaBytes(id: string): Promise<Uint8Array | null> {
  if (isLocalDataEnabled()) {
    const blobs = await loadAllLocalBlobs();
    const blob = blobs.get(id);
    if (!blob) return null;
    return new Uint8Array(await blob.arrayBuffer());
  }
  const res = await fetch(`/api/media/${encodeURIComponent(id)}`, {
    credentials: "same-origin",
  });
  if (!res.ok) return null;
  return new Uint8Array(await res.arrayBuffer());
}

/** Snapshot the live outline, kv rows, and image bytes for export. */
export async function gatherContentBackup(): Promise<ContentBackup> {
  const nodes = getLiveNodes();
  const kv: ContentBackupKvRow[] = [];
  for (const collection of BACKUP_KV_COLLECTIONS) {
    const rows = await kvFetch<unknown>(collection);
    for (const value of rows) {
      const key = inferKvKey(value, "");
      if (!key) continue;
      kv.push({ collection, key, value });
    }
  }

  const blobs: Record<string, ContentBackupBlob> = {};
  for (const row of mediaRowsFromKv(kv)) {
    const bytes = await fetchMediaBytes(row.id);
    if (!bytes) continue;
    blobs[row.id] = {
      contentType: row.contentType || "application/octet-stream",
      base64: encodeBlobBase64(bytes),
    };
  }

  return {
    version: CONTENT_BACKUP_VERSION,
    exportedAt: Date.now(),
    app: "aaflowy",
    nodes,
    kv,
    blobs,
  };
}

async function replaceKvCollection(
  collection: string,
  rows: readonly { key: string; value: unknown }[],
): Promise<void> {
  const current = await kvFetch<unknown>(collection);
  const keys = current
    .map((value) => inferKvKey(value, ""))
    .filter((key) => key.length > 0);
  if (keys.length) await kvDelete(collection, keys);
  if (rows.length) await kvPut(collection, [...rows]);
}

async function restoreMediaBlobs(backup: ContentBackup): Promise<MediaRow[]> {
  const restored: MediaRow[] = [];
  for (const row of mediaRowsFromBackup(backup)) {
    const blob = backup.blobs[row.id];
    if (!blob) continue;
    const bytes = decodeBlobBase64(blob.base64);
    const body = new Blob([new Uint8Array(bytes)], { type: blob.contentType });
    if (isLocalDataEnabled()) {
      await putLocalBlob(row.id, body);
      rememberLocalMediaUrl(row.id, body);
      restored.push(row);
      continue;
    }
    const res = await fetch(
      `/api/media?nodeId=${encodeURIComponent(row.nodeId)}`,
      {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "content-type": blob.contentType,
          "x-image-width": String(row.width),
          "x-image-height": String(row.height),
        },
        body,
      },
    );
    if (res.ok) restored.push((await res.json()) as MediaRow);
  }
  return restored;
}

async function restoreLunoraKv(
  backup: ContentBackup,
  userId: string,
  store: NonNullable<ReturnType<typeof getLunoraOutlineContext>>["store"],
): Promise<void> {
  const touchedAt = Date.now();
  const byCollection = new Map<string, ContentBackupKvRow[]>();
  for (const row of backup.kv) {
    const list = byCollection.get(row.collection) ?? [];
    list.push(row);
    byCollection.set(row.collection, list);
  }

  for (const row of store.tagColors.toArray) {
    const tag = String(row.tag ?? row._id);
    await store.mutators.deleteTagColor({ userId, tag }).isPersisted.promise;
  }
  for (const row of byCollection.get("tag-colors") ?? []) {
    const value = row.value as { tag?: string; color?: string };
    const tag = String(value.tag ?? row.key);
    const color = String(value.color ?? "");
    if (!tag || !color) continue;
    await store.mutators.upsertTagColor({ userId, tag, color }).isPersisted
      .promise;
  }

  for (const row of store.savedQueries.toArray) {
    await store.mutators.deleteSavedQueryRow({ userId, id: String(row._id) })
      .isPersisted.promise;
  }
  for (const row of byCollection.get("saved-queries") ?? []) {
    const value = row.value as {
      id?: string;
      name?: string;
      query?: string;
      createdAt?: number;
    };
    const id = String(value.id ?? row.key);
    if (!id) continue;
    await store.mutators.upsertSavedQuery({
      userId,
      id,
      name: String(value.name ?? value.query ?? id),
      query: String(value.query ?? ""),
      createdAt: Number(value.createdAt ?? touchedAt),
    }).isPersisted.promise;
  }

  for (const row of store.dailyIndex.toArray) {
    await store.mutators.deleteDailyMapping({
      userId,
      key: String(row.key ?? row._id),
    }).isPersisted.promise;
  }
  for (const row of byCollection.get("daily-index") ?? []) {
    const mapped = classicDailyRowToImport(
      { key: row.key, value: row.value },
      touchedAt,
    );
    if (!mapped) continue;
    await store.mutators.upsertDailyMapping({
      userId,
      key: mapped.key,
      nodeId: mapped.nodeId,
      touchedAt: mapped.touchedAt,
    }).isPersisted.promise;
  }
}

async function restoreKvRows(
  backup: ContentBackup,
  restoredMedia: readonly MediaRow[],
): Promise<void> {
  const byCollection = new Map<string, ContentBackupKvRow[]>();
  for (const row of backup.kv) {
    const list = byCollection.get(row.collection) ?? [];
    list.push(row);
    byCollection.set(row.collection, list);
  }

  if (isLunoraSyncEnabled()) {
    const lunora = getLunoraOutlineContext();
    if (lunora) {
      await restoreLunoraKv(backup, lunora.userId, lunora.store);
    }
  }

  for (const collection of BACKUP_KV_COLLECTIONS) {
    if (
      isLunoraSyncEnabled() &&
      (collection === "tag-colors" ||
        collection === "daily-index" ||
        collection === "saved-queries")
    ) {
      continue;
    }
    if (collection === "media") {
      await replaceKvCollection(
        "media",
        restoredMedia.map((row) => ({ key: row.id, value: row })),
      );
      continue;
    }
    const rows = byCollection.get(collection) ?? [];
    await replaceKvCollection(
      collection,
      rows.map((row) => ({ key: row.key, value: row.value })),
    );
  }
}

async function applyNodeRestore(index: TreeIndex, nodes: readonly Node[]) {
  const plan = planRestoreToNodes(index, nodes);
  if (isLunoraSyncEnabled()) {
    const lunora = getLunoraOutlineContext();
    if (!lunora) throw new Error("Sync is not ready");
    const outlineNodes = plan.targetNodes.map((n) => ({
      ...n,
      userId: lunora.userId,
    }));
    const tx = lunora.store.mutators.restoreNodes({
      userId: lunora.userId,
      nodes: outlineNodes,
    });
    await tx.isPersisted.promise;
    return;
  }
  if (plan.opCount < RESTORE_SLICE_OPS) {
    runStructural(() => {
      for (const slice of plan.slices) slice();
    });
    return;
  }
  await runStructuralSliced(plan.slices);
}

/** Download a gzip-compressed backup of the live outline. Browser-only. */
export async function exportContentBackupFile(): Promise<void> {
  const backup = await gatherContentBackup();
  if (backup.nodes.length === 0) throw new Error("empty");
  const compressed = await gzipJson(backup);
  const { downloadBlob } = await import("./download");
  downloadBlob(
    backupFilename(),
    "application/gzip",
    new Uint8Array(compressed),
  );
}

/** Replace the live outline and side-collections from a validated backup. */
export async function restoreContentBackup(
  backup: ContentBackup,
): Promise<void> {
  const index = getTreeIndex();
  capture(index, null);
  try {
    await applyNodeRestore(index, backup.nodes);
    const restoredMedia = await restoreMediaBlobs(backup);
    await restoreKvRows(backup, restoredMedia);
    for (const row of restoredMedia) {
      if (mediaCollection.has(row.id)) {
        mediaCollection.update(row.id, (draft) => Object.assign(draft, row));
      } else {
        mediaCollection.insert({ ...row });
      }
    }
  } catch (err) {
    drop();
    throw err;
  }
}
