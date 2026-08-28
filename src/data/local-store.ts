/**
 * Browser-only persistence for local-data mode. Outline nodes and kv side
 * collections live in localStorage; image bytes live in IndexedDB so they
 * don't blow the 5 MB localStorage quota. Nothing here talks to the network.
 */

import type { Node } from "./schema";

const NODES_KEY = "dotflowy:local:nodes";
const KV_PREFIX = "dotflowy:local:kv:";
const MEDIA_DB = "dotflowy-local";
const MEDIA_STORE = "blobs";

const objectUrls = new Map<string, string>();

function kvKey(collection: string): string {
  return `${KV_PREFIX}${collection}`;
}

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    throw new Error("Couldn't save locally. This browser's storage is full.");
  }
}

export function readLocalNodes(): Node[] {
  if (typeof window === "undefined") return [];
  const rows = readJson<unknown>(NODES_KEY, []);
  return Array.isArray(rows) ? (rows as Node[]) : [];
}

export function writeLocalNodes(nodes: readonly Node[]): void {
  if (typeof window === "undefined") return;
  writeJson(NODES_KEY, nodes);
}

export function readLocalKvRecord(collection: string): Record<string, unknown> {
  if (typeof window === "undefined") return {};
  const rows = readJson<unknown>(kvKey(collection), {});
  if (rows !== null && typeof rows === "object" && !Array.isArray(rows)) {
    return rows as Record<string, unknown>;
  }
  return {};
}

export function writeLocalKvRecord(
  collection: string,
  record: Record<string, unknown>,
): void {
  if (typeof window === "undefined") return;
  writeJson(kvKey(collection), record);
}

/** Pick a stable kv key from a row when the server didn't send one. */
export function inferKvKey(value: unknown, fallback: string): string {
  if (value !== null && typeof value === "object") {
    const row = value as Record<string, unknown>;
    if (typeof row.id === "string") return row.id;
    if (typeof row.tag === "string") return row.tag;
    if (typeof row.key === "string") return row.key;
  }
  return fallback;
}

function openMediaDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(MEDIA_DB, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(MEDIA_STORE)) {
        req.result.createObjectStore(MEDIA_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("open media db"));
  });
}

export async function putLocalBlob(id: string, blob: Blob): Promise<void> {
  // Copy into a plain Blob so IndexedDB doesn't store a clipboard File that
  // structured-clones as empty (visible until reload, gone after).
  const bytes = await blob.arrayBuffer();
  const stored = new Blob([bytes], {
    type: blob.type || "application/octet-stream",
  });
  const db = await openMediaDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(MEDIA_STORE, "readwrite");
    tx.objectStore(MEDIA_STORE).put(stored, id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("put blob"));
  });
  rememberLocalMediaUrl(id, stored);
}

export async function loadAllLocalBlobs(): Promise<Map<string, Blob>> {
  const db = await openMediaDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(MEDIA_STORE, "readonly");
    const req = tx.objectStore(MEDIA_STORE).openCursor();
    const out = new Map<string, Blob>();
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) {
        resolve(out);
        return;
      }
      out.set(String(cursor.key), cursor.value as Blob);
      cursor.continue();
    };
    req.onerror = () => reject(req.error ?? new Error("load blobs"));
  });
}

export function rememberLocalMediaUrl(id: string, blob: Blob): string {
  const prev = objectUrls.get(id);
  if (prev) URL.revokeObjectURL(prev);
  const url = URL.createObjectURL(blob);
  objectUrls.set(id, url);
  return url;
}

export function localMediaObjectUrl(id: string): string | undefined {
  return objectUrls.get(id);
}

export async function hydrateLocalMediaUrls(): Promise<void> {
  if (typeof window === "undefined" || typeof indexedDB === "undefined") {
    return;
  }
  const blobs = await loadAllLocalBlobs();
  for (const [id, blob] of blobs) rememberLocalMediaUrl(id, blob);
}

export async function copyRemoteMediaToLocal(
  rows: readonly { id: string }[],
): Promise<void> {
  for (const row of rows) {
    try {
      const res = await fetch(`/api/media/${row.id}`, {
        credentials: "same-origin",
      });
      if (!res.ok) continue;
      await putLocalBlob(row.id, await res.blob());
    } catch {
      // Leave that image behind rather than blocking the switch.
    }
  }
}
