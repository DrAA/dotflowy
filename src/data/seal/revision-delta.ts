/**
 * Sealed revision deltas (ADR 0063).
 *
 * The live R2 object stays a full sealed snapshot. Append-only revision
 * envelopes carry only upserts/deletes vs the last revision baseline so a
 * large outline does not re-upload ~full size on every checkpoint.
 */

import type { Node } from "../schema";

export const SEAL_REVISION_DELTA_VERSION = 1 as const;

export type SealRevisionDelta = {
  v: typeof SEAL_REVISION_DELTA_VERSION;
  upserts: Node[];
  deletes: string[];
};

/** Stable compare for "did this row change since the last revision?" */
export function nodesEqualForSeal(a: Node, b: Node): boolean {
  return (
    a.id === b.id &&
    a.parentId === b.parentId &&
    a.prevSiblingId === b.prevSiblingId &&
    a.text === b.text &&
    a.isTask === b.isTask &&
    a.completed === b.completed &&
    a.collapsed === b.collapsed &&
    a.bookmarkedAt === b.bookmarkedAt &&
    a.mirrorOf === b.mirrorOf &&
    a.createdAt === b.createdAt &&
    a.updatedAt === b.updatedAt &&
    a.origin === b.origin &&
    a.kind === b.kind
  );
}

export function sealRevisionDeltaIsEmpty(delta: SealRevisionDelta): boolean {
  return delta.upserts.length === 0 && delta.deletes.length === 0;
}

/**
 * Diff `current` against `baseline`. A null baseline means "first revision in
 * this session" — emit every node as an upsert (still smaller than a second
 * full snapshot once a baseline exists).
 */
export function buildSealRevisionDelta(
  current: readonly Node[],
  baseline: ReadonlyMap<string, Node> | null,
): SealRevisionDelta {
  if (baseline == null) {
    return {
      v: SEAL_REVISION_DELTA_VERSION,
      upserts: [...current],
      deletes: [],
    };
  }
  const upserts: Node[] = [];
  const seen = new Set<string>();
  for (const n of current) {
    seen.add(n.id);
    const prev = baseline.get(n.id);
    if (!prev || !nodesEqualForSeal(prev, n)) upserts.push(n);
  }
  const deletes: string[] = [];
  for (const id of baseline.keys()) {
    if (!seen.has(id)) deletes.push(id);
  }
  return { v: SEAL_REVISION_DELTA_VERSION, upserts, deletes };
}

export function nodesToBaselineMap(nodes: readonly Node[]): Map<string, Node> {
  const map = new Map<string, Node>();
  for (const n of nodes) map.set(n.id, n);
  return map;
}
