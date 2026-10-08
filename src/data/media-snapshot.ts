/**
 * Mid-session snapshot helpers for hosted images (ADR 0061).
 *
 * Parallel to `focused-typing.ts`: `collection.ts` must stash/re-layer media
 * across a wire truncate without a static import into `media.ts` (that path
 * pulls tree-store → collection and wedges load). The media module binds the
 * capture/reapply implementations once it loads.
 */

export type MediaSnapshotRow = {
  id: string;
  nodeId: string;
  contentType: string;
  bytes: number;
  width: number;
  height: number;
  createdAt: number;
};

/**
 * Rows to put back after a mid-session snapshot. Skip ids already present and
 * rows whose content node is no longer in the tree (real deletes).
 */
export function mediaRowsToReapply(
  stashed: readonly MediaSnapshotRow[],
  presentNodeIds: ReadonlySet<string>,
  heldMediaIds: ReadonlySet<string>,
): MediaSnapshotRow[] {
  const out: MediaSnapshotRow[] = [];
  for (const row of stashed) {
    if (heldMediaIds.has(row.id)) continue;
    if (!presentNodeIds.has(row.nodeId)) continue;
    out.push(row);
  }
  return out;
}

let gcDepth = 0;

/** True while a mid-session nodes snapshot is applying (truncate → reapply). */
export function isMediaGcSuppressed(): boolean {
  return gcDepth > 0;
}

/** Suppress tree-driven media orphan GC for the duration of `fn`. */
export function withMediaGcSuppressed<T>(fn: () => T): T {
  gcDepth++;
  try {
    return fn();
  } finally {
    gcDepth--;
  }
}

let captureImpl: () => MediaSnapshotRow[] = () => [];
let reapplyImpl: (rows: readonly MediaSnapshotRow[]) => void = () => {};

/** Wire capture/reapply from the media module once the outline UI loads. */
export function bindMediaSnapshot(handlers: {
  capture: () => MediaSnapshotRow[];
  reapply: (rows: readonly MediaSnapshotRow[]) => void;
}): void {
  captureImpl = handlers.capture;
  reapplyImpl = handlers.reapply;
}

/** Snapshot media rows before a mid-session nodes truncate. */
export function captureMediaForSnapshot(): MediaSnapshotRow[] {
  return captureImpl();
}

/** Re-insert stashed rows that the truncate/orphan path dropped. */
export function reapplyMediaAfterSnapshot(
  rows: readonly MediaSnapshotRow[],
): void {
  if (rows.length === 0) return;
  reapplyImpl(rows);
}
