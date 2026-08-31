import { toast } from "sonner";

import {
  isNodesLimitError,
  isRetriableNodesError,
} from "./nodes-client-effect";

/**
 * User-visible signals when outline persistence fails or is deferred.
 *
 * Retriable failures (transport, timeout, 5xx) enqueue in `write-queue.ts` and
 * keep optimistic edits on screen. Non-retriable failures (node limit, most 4xx)
 * still roll back via TanStack DB's throw-on-failure contract.
 */

const QUEUED_TOAST_ID = "persist-queued";

/** Warn that edits are kept locally and will retry — not rolled back. */
export function notifyPersistQueued(pendingCount: number): void {
  if (pendingCount <= 0) {
    toast.dismiss(QUEUED_TOAST_ID);
    return;
  }
  toast.warning("Changes not saved yet", {
    id: QUEUED_TOAST_ID,
    description: `${pendingCount === 1 ? "1 edit is" : `${pendingCount} edits are`} waiting to sync. Check your connection — we'll retry automatically.`,
    duration: Infinity,
  });
}

/** A permanent failure while flushing the queue or a non-retriable write error. */
export function notifyPersistFailed(err: unknown): void {
  if (isNodesLimitError(err)) return;
  toast.error("Couldn't save your changes", {
    id: "save-failed",
    description:
      "Some edits couldn't be synced. Check your connection and try again.",
  });
}

/** @deprecated Use notifyPersistFailed — kept for call sites not yet migrated. */
export const notifySaveFailed = notifyPersistFailed;

/**
 * Await a write promise. Retriable failures are handled by the caller (queue
 * + resolve); this surfaces permanent failures and re-throws for rollback.
 */
export async function persistOrNotify<T>(p: Promise<T>): Promise<T> {
  try {
    return await p;
  } catch (err) {
    if (isRetriableNodesError(err)) throw err;
    notifyPersistFailed(err);
    throw err;
  }
}

/**
 * Await a write promise; on retriable failure run `onQueue` and return without
 * throwing so TanStack DB keeps the optimistic edit.
 */
export async function persistOrQueue<T>(
  p: Promise<T>,
  onQueue: () => void,
): Promise<T> {
  try {
    return await p;
  } catch (err) {
    if (isRetriableNodesError(err)) {
      onQueue();
      return undefined as T;
    }
    notifyPersistFailed(err);
    throw err;
  }
}
