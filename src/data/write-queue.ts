/**
 * Durable FIFO queue for outline writes that couldn't reach the server (#230
 * follow-up). Retriable failures enqueue instead of rolling back optimistic
 * edits. The queue and a full outline snapshot live in `localStorage` so both
 * survive reload until the server accepts every pending write.
 */

import type { ChangeOp } from "./realtime";
import type { Node } from "./schema";

import { isLocalDataEnabled } from "./flags";
import {
  createNodesE,
  deleteNodesE,
  isRetriableNodesError,
  runPromise,
  sendBatchE,
  updateNodesE,
} from "./nodes-client-effect";
import { notifyPersistFailed, notifyPersistQueued } from "./save-failure";

const QUEUE_KEY = "dotflowy:write-queue";
const SNAPSHOT_NODES_KEY = "dotflowy:write-queue:nodes";

export type WriteQueueEntry =
  | { id: string; kind: "structural"; ops: ChangeOp[] }
  | {
      id: string;
      kind: "field";
      updates: { id: string; changes: Partial<Node> }[];
    }
  | { id: string; kind: "create"; nodes: Node[] }
  | { id: string; kind: "delete"; ids: string[] };

let queue: WriteQueueEntry[] = loadQueue();
let flushing = false;
let started = false;

const queueListeners = new Set<() => void>();

function emitQueueChange(): void {
  for (const listener of queueListeners) listener();
}

/** Subscribe to pending-write count changes (enqueue, flush, cross-tab storage). */
export function subscribePendingWrites(listener: () => void): () => void {
  queueListeners.add(listener);
  return () => {
    queueListeners.delete(listener);
  };
}

function loadQueue(): WriteQueueEntry[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(QUEUE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as WriteQueueEntry[]) : [];
  } catch {
    return [];
  }
}

/** Re-read the queue from `localStorage` (reload or another tab wrote). */
export function reloadWriteQueueFromStorage(): void {
  queue = loadQueue();
}

function persistQueueAndSnapshot(snapshot: readonly Node[]): void {
  if (typeof window === "undefined") return;
  try {
    if (queue.length === 0) {
      window.localStorage.removeItem(QUEUE_KEY);
      window.localStorage.removeItem(SNAPSHOT_NODES_KEY);
      return;
    }
    window.localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
    window.localStorage.setItem(SNAPSHOT_NODES_KEY, JSON.stringify(snapshot));
  } catch {
    // Storage full — in-memory queue still drains this session.
  }
}

function clearPersistedQueue(): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(QUEUE_KEY);
  window.localStorage.removeItem(SNAPSHOT_NODES_KEY);
}

/** How many writes are waiting to reach the server. */
export function getPendingWriteCount(): number {
  return queue.length;
}

/** Enqueue a write after a retriable persistence failure. */
export function enqueueWrite(
  entry:
    | { kind: "structural"; ops: ChangeOp[] }
    | {
        kind: "field";
        updates: { id: string; changes: Partial<Node> }[];
      }
    | { kind: "create"; nodes: Node[] }
    | { kind: "delete"; ids: string[] },
  snapshot: readonly Node[],
): void {
  if (isLocalDataEnabled()) return;
  const full: WriteQueueEntry = { ...entry, id: crypto.randomUUID() };
  queue.push(full);
  persistQueueAndSnapshot(snapshot);
  notifyPersistQueued(queue.length);
  emitQueueChange();
  scheduleFlush();
}

async function dispatchEntry(entry: WriteQueueEntry): Promise<void> {
  switch (entry.kind) {
    case "structural":
      await runPromise(sendBatchE(entry.ops));
      return;
    case "field":
      await runPromise(updateNodesE(entry.updates));
      return;
    case "create":
      await runPromise(createNodesE(entry.nodes));
      return;
    case "delete":
      await runPromise(deleteNodesE(entry.ids));
      return;
  }
}

/** Drain queued writes in order. Stops on the first retriable failure. */
export async function flushWriteQueue(): Promise<void> {
  if (flushing || isLocalDataEnabled()) return;
  reloadWriteQueueFromStorage();
  if (queue.length === 0) return;
  flushing = true;
  try {
    while (queue.length > 0) {
      const entry = queue[0]!;
      try {
        await dispatchEntry(entry);
        queue.shift();
        const snapshotRaw =
          typeof window !== "undefined"
            ? window.localStorage.getItem(SNAPSHOT_NODES_KEY)
            : null;
        if (queue.length === 0) {
          clearPersistedQueue();
        } else if (snapshotRaw) {
          window.localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
        }
      } catch (err) {
        if (isRetriableNodesError(err)) {
          notifyPersistQueued(queue.length);
          return;
        }
        queue.shift();
        if (queue.length === 0) clearPersistedQueue();
        else if (typeof window !== "undefined") {
          window.localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
        }
        notifyPersistFailed(err);
        return;
      }
    }
    notifyPersistQueued(0);
  } finally {
    flushing = false;
    emitQueueChange();
  }
}

function scheduleFlush(): void {
  queueMicrotask(() => {
    void flushWriteQueue();
  });
}

/**
 * Full outline snapshot saved alongside the queue — used to repaint local state
 * after reload before the queued writes land on the server.
 */
export function restoreQueuedSnapshotIfPresent(): Node[] | null {
  if (typeof window === "undefined") return null;
  reloadWriteQueueFromStorage();
  if (queue.length === 0) {
    clearPersistedQueue();
    return null;
  }
  try {
    const raw = window.localStorage.getItem(SNAPSHOT_NODES_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as Node[]) : null;
  } catch {
    return null;
  }
}

function onStorageSync(event: StorageEvent): void {
  if (event.key !== QUEUE_KEY && event.key !== SNAPSHOT_NODES_KEY) return;
  reloadWriteQueueFromStorage();
  emitQueueChange();
  if (queue.length > 0) notifyPersistQueued(queue.length);
  else notifyPersistQueued(0);
}

/** Wire online/reload retry. Idempotent. */
export function startWriteQueue(): void {
  if (started || typeof window === "undefined" || isLocalDataEnabled()) return;
  started = true;
  reloadWriteQueueFromStorage();
  if (queue.length > 0) notifyPersistQueued(queue.length);
  window.addEventListener("online", () => {
    void flushWriteQueue();
  });
  window.addEventListener("storage", onStorageSync);
  if (queue.length > 0) scheduleFlush();
}

/** @internal Reset module state between unit tests. */
export function resetWriteQueueForTests(): void {
  queue = [];
  flushing = false;
  started = false;
  clearPersistedQueue();
  emitQueueChange();
}

/** @internal Drop in-memory queue only (simulate a fresh page load). */
export function clearWriteQueueMemoryForTests(): void {
  queue = [];
  flushing = false;
  started = false;
}
