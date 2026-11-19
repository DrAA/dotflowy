/**
 * Sealed outline hydrate / persist / migrate (ADR 0063) + live revision pull
 * (ADR 0064).
 *
 * Live durability is a full sealed snapshot in R2 with OCC (`seal_snapshot_seq`).
 * Field edits debounce and overwrite that snapshot only. Revisions are sealed
 * upsert/delete deltas against the last revision baseline (structural flush +
 * idle), and remote devices pull those deltas to converge.
 */

import { toast } from "sonner";

import type { Node } from "../schema";

import {
  fetchSealRevisionsAfter,
  fetchSealState,
  fetchSealedSnapshot,
  postSealRevision,
  putSealedSnapshot,
  SealSnapshotConflictError,
} from "./api";
import { sealJson, unsealJson, type SealedEnvelope } from "./envelope";
import {
  applySealRevisionDeltaToMap,
  buildSealRevisionDelta,
  nodesToBaselineMap,
  sealRevisionDeltaIsEmpty,
  type SealRevisionDelta,
} from "./revision-delta";
import { getSealDek } from "./session";

/** Bound from collection.ts so sync never statically imports the collection. */
export type SealCollectionBridge = {
  applyRemoteDelta: (delta: SealRevisionDelta) => void;
};

let collectionBridge: SealCollectionBridge | null = null;

/** Register collection apply hooks (called once from collection bootstrap). */
export function bindSealCollectionBridge(bridge: SealCollectionBridge): void {
  collectionBridge = bridge;
}

export type SealedOutlinePayload = {
  nodes: Node[];
};

/** Debounce for keystroke/field persists (snapshot only). */
export const SEAL_FIELD_DEBOUNCE_MS = 4000;
/** After the last snapshot-only persist, append one revision once idle. */
export const SEAL_IDLE_REVISION_MS = 2_000;
/**
 * Fallback poll while unlocked — WS `seal_rev` is the primary path; this only
 * covers a missed poke / half-open socket.
 */
export const SEAL_REVISION_POLL_MS = 30_000;
const SEAL_PUT_MAX_ATTEMPTS = 4;

let fieldDebounceMs = SEAL_FIELD_DEBOUNCE_MS;
let idleRevisionMs = SEAL_IDLE_REVISION_MS;

let persistTimer: ReturnType<typeof setTimeout> | null = null;
let idleRevisionTimer: ReturnType<typeof setTimeout> | null = null;
let persistSeq = 0;

/** OCC token mirroring DO `seal_snapshot_seq`. */
let localSnapshotSeq = 0;
/** Highest applied/seen sealed revision seq. */
let localRevSeq = 0;

/** Latest outline copy the UI asked to persist. */
let latestNodes: Node[] | null = null;
/** Nodes waiting for the serialize pump (null = nothing pending). */
let queuedNodes: Node[] | null = null;
/** Once set, the next completed persist also appends a revision. */
let queuedWantRevision = false;
let flying: Promise<void> | null = null;
/** Last outline successfully written as a revision (delta baseline). */
let revisionBaseline: Map<string, Node> | null = null;

/** Stop further PUTs after OCC conflict until reload. */
let conflictBlocked = false;
let pagehideInstalled = false;
let revisionPollTimer: ReturnType<typeof setInterval> | null = null;
let revisionPullFlying: Promise<void> | null = null;

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransientPersistError(err: unknown): boolean {
  if (err instanceof SealSnapshotConflictError) return false;
  if (!(err instanceof Error)) return true;
  const msg = err.message;
  // Empty/aborted nginx 400s and 5xx / network failures.
  return (
    /Couldn't save sealed snapshot \((0|400|408|429|5\d\d)\)/.test(msg) ||
    /Failed to fetch|NetworkError|network|abort/i.test(msg)
  );
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
  const revSeq = await postSealRevision(envelope);
  if (revSeq > localRevSeq) localRevSeq = revSeq;
}

function handleSnapshotConflict(err: SealSnapshotConflictError): void {
  conflictBlocked = true;
  localSnapshotSeq = err.snapshotSeq;
  queuedNodes = null;
  queuedWantRevision = false;
  clearPersistTimer();
  clearIdleRevisionTimer();
  // Detect-and-reload (Phase A). Phase B soft-merges via revision pull; OCC
  // still forces a full rehydrate when the live snapshot diverged.
  if (typeof window !== "undefined") {
    toast.error("Another device saved a newer outline. Reloading…", {
      duration: 8_000,
    });
    window.setTimeout(() => {
      window.location.reload();
    }, 600);
  }
}

function notifyPersistFailed(err: unknown): void {
  const msg =
    err instanceof Error ? err.message : "Couldn't save the sealed outline.";
  console.error("[seal] persist failed", err);
  if (typeof window !== "undefined") {
    toast.error(`${msg} Keeping a local copy — retrying when online.`, {
      duration: 10_000,
    });
  }
}

async function putSnapshotWithRetry(
  envelope: SealedEnvelope,
  expectedSeq: number,
): Promise<number> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= SEAL_PUT_MAX_ATTEMPTS; attempt++) {
    try {
      return await putSealedSnapshot(envelope, expectedSeq);
    } catch (err) {
      if (err instanceof SealSnapshotConflictError) throw err;
      lastErr = err;
      if (!isTransientPersistError(err) || attempt === SEAL_PUT_MAX_ATTEMPTS) {
        throw err;
      }
      await sleep(250 * attempt * attempt);
    }
  }
  throw lastErr instanceof Error
    ? lastErr
    : new Error("Couldn't save sealed snapshot.");
}

/** Seal + upload. Returns false when superseded by a newer queued outline. */
async function writeSealedSnapshot(
  nodes: readonly Node[],
  opts: { revision: boolean },
): Promise<boolean> {
  if (conflictBlocked) return true;
  const dek = getSealDek();
  if (!dek) throw new Error("Seal is locked.");

  // Merge remote revisions before compacting so a snapshot cannot omit nodes
  // another device already appended (ADR 0064).
  try {
    await pullRemoteRevisionsOnce();
  } catch (err) {
    console.error("[seal] pre-persist revision pull failed", err);
  }
  if (queuedNodes) {
    if (opts.revision) queuedWantRevision = true;
    return false;
  }
  // Prefer the post-pull outline (local queue + remote LWW merges).
  const toWrite = latestNodes ? [...latestNodes] : [...nodes];

  const snapshotSeq = ++persistSeq;
  const expectedSeq = localSnapshotSeq;
  const snapshotEnvelope = await sealJson(dek, "snapshot", snapshotSeq, {
    nodes: toWrite,
  });
  // Drop work that went stale during encrypt; keep revision intent for the
  // newer queue so a structural flush is not lost behind a follow-up keystroke.
  if (queuedNodes) {
    if (opts.revision) queuedWantRevision = true;
    return false;
  }
  try {
    localSnapshotSeq = await putSnapshotWithRetry(
      snapshotEnvelope,
      expectedSeq,
    );
  } catch (err) {
    if (err instanceof SealSnapshotConflictError) {
      handleSnapshotConflict(err);
      throw err;
    }
    throw err;
  }

  if (opts.revision) {
    const delta = buildSealRevisionDelta(toWrite, revisionBaseline);
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
      setRevisionBaseline(toWrite);
    }
  }
  return true;
}

async function drainPersistQueue(): Promise<void> {
  let lastError: unknown;
  while (queuedNodes) {
    if (conflictBlocked) {
      queuedNodes = null;
      queuedWantRevision = false;
      break;
    }
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
      lastError = undefined;
    } catch (err) {
      lastError = err;
      if (err instanceof SealSnapshotConflictError) break;
      notifyPersistFailed(err);
      // Re-queue so a later flush / pagehide / visibility can retry.
      if (!queuedNodes) {
        queuedNodes = latestNodes;
        if (wantRevision) queuedWantRevision = true;
      }
      break;
    }
  }
  if (lastError && !(lastError instanceof SealSnapshotConflictError)) {
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }
  if (lastError instanceof SealSnapshotConflictError) throw lastError;
}

function kickPersist(): Promise<void> {
  if (flying) return flying;
  flying = drainPersistQueue().finally(() => {
    flying = null;
    if (queuedNodes && !conflictBlocked) void kickPersist();
  });
  return flying;
}

function enqueuePersist(
  nodes: readonly Node[],
  opts: { revision: boolean; immediate: boolean },
): Promise<void> {
  if (conflictBlocked) return Promise.resolve();
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

function installPagehideFlush(): void {
  if (pagehideInstalled || typeof window === "undefined") return;
  pagehideInstalled = true;
  const flush = () => {
    if (!getSealDek() || conflictBlocked || !latestNodes) return;
    // Best-effort kick — browser may kill the tab mid-upload.
    void enqueuePersist(latestNodes, { revision: true, immediate: true });
  };
  window.addEventListener("pagehide", flush);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flush();
  });
}

function applyRemoteDeltaToCollection(delta: SealRevisionDelta): void {
  collectionBridge?.applyRemoteDelta(delta);
}

async function pullRemoteRevisionsOnce(): Promise<void> {
  const dek = getSealDek();
  if (!dek || conflictBlocked) return;
  const { revisions, revSeq } = await fetchSealRevisionsAfter(localRevSeq);
  if (revSeq > localRevSeq && revisions.length === 0) {
    // Server advanced past pruned window — fall back to full snapshot reload.
    localRevSeq = revSeq;
    return;
  }
  for (const item of revisions) {
    if (item.seq <= localRevSeq) continue;
    const delta = await unsealJson<SealRevisionDelta>(dek, item.envelope);
    applyRemoteDeltaToCollection(delta);
    if (revisionBaseline) {
      applySealRevisionDeltaToMap(revisionBaseline, delta);
    }
    localRevSeq = item.seq;
    if (latestNodes) {
      const map = nodesToBaselineMap(latestNodes);
      applySealRevisionDeltaToMap(map, delta);
      latestNodes = [...map.values()];
    }
  }
  if (revSeq > localRevSeq) localRevSeq = revSeq;
}

function startRevisionPolling(): void {
  if (revisionPollTimer || typeof window === "undefined") return;
  revisionPollTimer = setInterval(() => {
    void requestSealRevisionPull();
  }, SEAL_REVISION_POLL_MS);
}

/**
 * Pull remote sealed revisions now (WS `seal_rev` poke, wake, or poll fallback).
 * Coalesces overlapping calls onto one in-flight pull.
 */
export function requestSealRevisionPull(): Promise<void> {
  if (revisionPullFlying) return revisionPullFlying;
  if (conflictBlocked || !getSealDek()) return Promise.resolve();
  revisionPullFlying = pullRemoteRevisionsOnce()
    .catch((err) => {
      console.error("[seal] revision pull failed", err);
    })
    .finally(() => {
      revisionPullFlying = null;
    });
  return revisionPullFlying;
}

/** Load nodes for the sealed collection path (migrate plaintext if needed). */
export async function loadSealedNodes(): Promise<Node[]> {
  const dek = getSealDek();
  if (!dek) throw new Error("Seal is locked.");

  conflictBlocked = false;
  installPagehideFlush();

  const state = await fetchSealState();
  localSnapshotSeq = state.snapshotSeq;
  // Pull baseline is the snapshot watermark — not tip — so post-compact
  // revisions from other devices still apply (ADR 0064).
  localRevSeq = state.snapshotAtRev;

  const existing = await fetchSealedSnapshot();
  if (existing.envelope) {
    localSnapshotSeq = existing.snapshotSeq;
    localRevSeq = existing.snapshotAtRev;
    const payload = await unsealJson<SealedOutlinePayload>(
      dek,
      existing.envelope,
    );
    let nodes = Array.isArray(payload.nodes) ? payload.nodes : [];
    // Catch up any revisions newer than the compacted snapshot baseline.
    const { revisions, revSeq } = await fetchSealRevisionsAfter(localRevSeq);
    if (revisions.length > 0) {
      const map = nodesToBaselineMap(nodes);
      for (const item of revisions) {
        const delta = await unsealJson<SealRevisionDelta>(dek, item.envelope);
        applySealRevisionDeltaToMap(map, delta);
        localRevSeq = item.seq;
      }
      nodes = [...map.values()];
    }
    if (revSeq > localRevSeq) localRevSeq = revSeq;
    setRevisionBaseline(nodes);
    latestNodes = nodes;
    startRevisionPolling();
    return nodes;
  }

  // One-shot migration: seal whatever plaintext remains, then wipe it.
  if (state.hasPlaintextNodes) {
    const nodes = await fetchPlaintextNodes();
    const envelope = await sealJson(dek, "snapshot", ++persistSeq, { nodes });
    localSnapshotSeq = await putSnapshotWithRetry(envelope, localSnapshotSeq);
    const delta = buildSealRevisionDelta(nodes, null);
    const revisionEnvelope = await sealJson(dek, "revision", persistSeq, delta);
    await appendRevision(revisionEnvelope);
    setRevisionBaseline(nodes);
    latestNodes = nodes;
    await clearPlaintextOnServer();
    startRevisionPolling();
    return nodes;
  }

  // Empty sealed outline (new account after seal setup).
  const empty = await sealJson(dek, "snapshot", ++persistSeq, { nodes: [] });
  localSnapshotSeq = await putSnapshotWithRetry(empty, localSnapshotSeq);
  setRevisionBaseline([]);
  latestNodes = [];
  await clearPlaintextOnServer();
  startRevisionPolling();
  return [];
}

/** Immediate snapshot + revision (migrate / explicit callers). */
export async function persistSealedNodes(
  nodes: readonly Node[],
): Promise<void> {
  clearIdleRevisionTimer();
  await enqueuePersist(nodes, { revision: true, immediate: true });
}

/**
 * Debounced persist for keystroke-heavy field edits. Includes a revision so
 * other unlocked browsers see text via `seal_rev` poke (ADR 0064), not only
 * after a long idle window.
 */
export function schedulePersistSealedNodes(nodes: readonly Node[]): void {
  clearIdleRevisionTimer();
  void enqueuePersist(nodes, { revision: true, immediate: false });
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

/** Test-only: seed OCC / revision cursors. */
export function setSealSyncCursorsForTests(opts: {
  snapshotSeq?: number;
  revSeq?: number;
}): void {
  if (opts.snapshotSeq != null) localSnapshotSeq = opts.snapshotSeq;
  if (opts.revSeq != null) localRevSeq = opts.revSeq;
  conflictBlocked = false;
}

/** Test-only: drop timers/queue between cases (awaits in-flight first). */
export async function resetSealPersistForTests(): Promise<void> {
  clearPersistTimer();
  clearIdleRevisionTimer();
  if (revisionPollTimer) {
    clearInterval(revisionPollTimer);
    revisionPollTimer = null;
  }
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
  localSnapshotSeq = 0;
  localRevSeq = 0;
  conflictBlocked = false;
  configureSealPersistForTests();
}
