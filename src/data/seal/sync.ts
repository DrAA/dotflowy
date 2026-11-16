/**
 * Sealed outline hydrate / persist / migrate (ADR 0063).
 *
 * Live durability is a full sealed snapshot in R2. Field edits debounce and
 * overwrite that snapshot only. Revisions are sealed upsert/delete deltas
 * against the last revision baseline (structural flush + idle), not a second
 * full outline upload. Persists are serialized so encrypt/upload cannot pile up.
 */

import type { Node } from "../schema";

import { fetchSealState, fetchSealedSnapshot, putSealedSnapshot } from "./api";
import { sealJson, unsealJson, type SealedEnvelope } from "./envelope";
import {
  buildSealRevisionDelta,
  nodesToBaselineMap,
  sealRevisionDeltaIsEmpty,
} from "./revision-delta";
import { getSealDek } from "./session";

export type SealedOutlinePayload = {
  nodes: Node[];
};

/** Debounce for keystroke/field persists (snapshot only). */
export const SEAL_FIELD_DEBOUNCE_MS = 4000;
/** After the last snapshot-only persist, append one revision once idle. */
export const SEAL_IDLE_REVISION_MS = 15_000;

let fieldDebounceMs = SEAL_FIELD_DEBOUNCE_MS;
let idleRevisionMs = SEAL_IDLE_REVISION_MS;

let persistTimer: ReturnType<typeof setTimeout> | null = null;
let idleRevisionTimer: ReturnType<typeof setTimeout> | null = null;
let persistSeq = 0;

/** Latest outline copy the UI asked to persist. */
let latestNodes: Node[] | null = null;
/** Nodes waiting for the serialize pump (null = nothing pending). */
let queuedNodes: Node[] | null = null;
/** Once set, the next completed persist also appends a revision. */
let queuedWantRevision = false;
let flying: Promise<void> | null = null;
/** Last outline successfully written as a revision (delta baseline). */
let revisionBaseline: Map<string, Node> | null = null;

function clearPersistTimer(): void {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
}

function clearIdleRevisionTimer(): void {
  if (idleRevisionTimer) {
    clearTimeout(idleRevisionTimer);
    idleRevisionTimer = null;
  }
}

function armIdleRevision(): void {
  clearIdleRevisionTimer();
  idleRevisionTimer = setTimeout(() => {
    idleRevisionTimer = null;
    if (!latestNodes) return;
    queuedNodes = latestNodes;
    queuedWantRevision = true;
    void kickPersist();
  }, idleRevisionMs);
}

function setRevisionBaseline(nodes: readonly Node[]): void {
  revisionBaseline = nodesToBaselineMap(nodes);
}

async function fetchPlaintextNodes(): Promise<Node[]> {
  const res = await fetch("/api/nodes", { credentials: "include" });
  if (!res.ok)
    throw new Error(`Couldn't load outline for sealing (${res.status}).`);
  const data = (await res.json()) as unknown;
  return Array.isArray(data) ? (data as Node[]) : [];
}

async function clearPlaintextOnServer(): Promise<void> {
  const res = await fetch("/api/seal/clear-plaintext", {
    method: "POST",
    credentials: "include",
  });
  if (!res.ok) {
    throw new Error(`Couldn't clear plaintext outline (${res.status}).`);
  }
}

async function appendRevision(envelope: SealedEnvelope): Promise<void> {
  const res = await fetch("/api/seal/revisions", {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ envelope }),
  });
  if (!res.ok) {
    throw new Error(`Couldn't append sealed revision (${res.status}).`);
  }
}

/** Seal + upload. Returns false when superseded by a newer queued outline. */
async function writeSealedSnapshot(
  nodes: readonly Node[],
  opts: { revision: boolean },
): Promise<boolean> {
  const dek = getSealDek();
  if (!dek) throw new Error("Seal is locked.");
  const snapshotSeq = ++persistSeq;
  const snapshotEnvelope = await sealJson(dek, "snapshot", snapshotSeq, {
    nodes: [...nodes],
  });
  // Drop work that went stale during encrypt; keep revision intent for the
  // newer queue so a structural flush is not lost behind a follow-up keystroke.
  if (queuedNodes) {
    if (opts.revision) queuedWantRevision = true;
    return false;
  }
  await putSealedSnapshot(snapshotEnvelope);

  if (opts.revision) {
    const delta = buildSealRevisionDelta(nodes, revisionBaseline);
    if (!sealRevisionDeltaIsEmpty(delta)) {
      // Re-check supersession after the snapshot PUT (network can be slow).
      if (queuedNodes) {
        queuedWantRevision = true;
        return true;
      }
      const revisionEnvelope = await sealJson(
        dek,
        "revision",
        snapshotSeq,
        delta,
      );
      if (queuedNodes) {
        queuedWantRevision = true;
        return true;
      }
      await appendRevision(revisionEnvelope);
      setRevisionBaseline(nodes);
    }
  }
  return true;
}

async function drainPersistQueue(): Promise<void> {
  while (queuedNodes) {
    const nodes = queuedNodes;
    const wantRevision = queuedWantRevision;
    queuedNodes = null;
    queuedWantRevision = false;
    try {
      const wrote = await writeSealedSnapshot(nodes, {
        revision: wantRevision,
      });
      if (!wrote) continue;
      if (wantRevision) clearIdleRevisionTimer();
      else armIdleRevision();
    } catch (err) {
      console.error("[seal] persist failed", err);
    }
  }
}

function kickPersist(): Promise<void> {
  if (flying) return flying;
  flying = drainPersistQueue().finally(() => {
    flying = null;
    if (queuedNodes) void kickPersist();
  });
  return flying;
}

function enqueuePersist(
  nodes: readonly Node[],
  opts: { revision: boolean; immediate: boolean },
): Promise<void> {
  latestNodes = [...nodes];
  queuedNodes = latestNodes;
  if (opts.revision) queuedWantRevision = true;
  if (opts.immediate) {
    clearPersistTimer();
    return kickPersist();
  }
  clearPersistTimer();
  persistTimer = setTimeout(() => {
    persistTimer = null;
    void kickPersist();
  }, fieldDebounceMs);
  return Promise.resolve();
}

/** Load nodes for the sealed collection path (migrate plaintext if needed). */
export async function loadSealedNodes(): Promise<Node[]> {
  const dek = getSealDek();
  if (!dek) throw new Error("Seal is locked.");

  const state = await fetchSealState();
  const existing = await fetchSealedSnapshot();

  if (existing) {
    const payload = await unsealJson<SealedOutlinePayload>(dek, existing);
    const nodes = Array.isArray(payload.nodes) ? payload.nodes : [];
    // Session baseline = live snapshot so the next revision is a real delta,
    // not another full-outline upsert dump.
    setRevisionBaseline(nodes);
    return nodes;
  }

  // One-shot migration: seal whatever plaintext remains, then wipe it.
  if (state.hasPlaintextNodes) {
    const nodes = await fetchPlaintextNodes();
    const envelope = await sealJson(dek, "snapshot", ++persistSeq, { nodes });
    await putSealedSnapshot(envelope);
    const delta = buildSealRevisionDelta(nodes, null);
    const revisionEnvelope = await sealJson(dek, "revision", persistSeq, delta);
    await appendRevision(revisionEnvelope);
    setRevisionBaseline(nodes);
    await clearPlaintextOnServer();
    return nodes;
  }

  // Empty sealed outline (new account after seal setup).
  const empty = await sealJson(dek, "snapshot", ++persistSeq, { nodes: [] });
  await putSealedSnapshot(empty);
  setRevisionBaseline([]);
  await clearPlaintextOnServer();
  return [];
}

/** Immediate snapshot + revision (migrate / explicit callers). */
export async function persistSealedNodes(
  nodes: readonly Node[],
): Promise<void> {
  clearIdleRevisionTimer();
  await enqueuePersist(nodes, { revision: true, immediate: true });
}

/** Debounced snapshot-only persist for keystroke-heavy field edits. */
export function schedulePersistSealedNodes(nodes: readonly Node[]): void {
  clearIdleRevisionTimer();
  void enqueuePersist(nodes, { revision: false, immediate: false });
}

/** Flush snapshot + revision (structural edits — await before continuing). */
export async function flushPersistSealedNodes(
  nodes: readonly Node[],
): Promise<void> {
  clearIdleRevisionTimer();
  await enqueuePersist(nodes, { revision: true, immediate: true });
}

/**
 * Kick a sealed snapshot(+revision) without awaiting. Used by `runStructural`'s
 * mutationFn so Enter can confirm the optimistic row and accept keystrokes
 * instead of holding TanStack's overlay across a multi-MB encrypt/upload.
 */
export function queuePersistSealedNodes(
  nodes: readonly Node[],
  opts?: { revision?: boolean },
): void {
  clearIdleRevisionTimer();
  const snapshot = [...nodes];
  const revision = opts?.revision ?? true;
  // Defer past the current Enter focus/layout pass so the new row mounts and
  // receives the caret before JSON.stringify+AES of a large outline runs.
  setTimeout(() => {
    void enqueuePersist(snapshot, { revision, immediate: true });
  }, 0);
}

/** Test-only: shorten timers and clear queue state between cases. */
export function configureSealPersistForTests(opts?: {
  fieldDebounceMs?: number;
  idleRevisionMs?: number;
}): void {
  fieldDebounceMs = opts?.fieldDebounceMs ?? SEAL_FIELD_DEBOUNCE_MS;
  idleRevisionMs = opts?.idleRevisionMs ?? SEAL_IDLE_REVISION_MS;
}

/** Test-only: drop timers/queue between cases (awaits in-flight first). */
export async function resetSealPersistForTests(): Promise<void> {
  clearPersistTimer();
  clearIdleRevisionTimer();
  if (flying) {
    try {
      await flying;
    } catch {
      // ignore
    }
  }
  latestNodes = null;
  queuedNodes = null;
  queuedWantRevision = false;
  revisionBaseline = null;
  persistSeq = 0;
  configureSealPersistForTests();
}
