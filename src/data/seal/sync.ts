/**
 * Sealed outline hydrate / persist / migrate (ADR 0063).
 * Full-snapshot seal on each persist; revisions are sealed snapshots appended
 * server-side for recovery history (not yet replayed on hydrate).
 */

import type { Node } from "../schema";

import { fetchSealState, fetchSealedSnapshot, putSealedSnapshot } from "./api";
import { sealJson, unsealJson, type SealedEnvelope } from "./envelope";
import { getSealDek } from "./session";

export type SealedOutlinePayload = {
  nodes: Node[];
};

let persistTimer: ReturnType<typeof setTimeout> | null = null;
let persistSeq = 0;

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
  await fetch("/api/seal/revisions", {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ envelope }),
  });
}

/** Load nodes for the sealed collection path (migrate plaintext if needed). */
export async function loadSealedNodes(): Promise<Node[]> {
  const dek = getSealDek();
  if (!dek) throw new Error("Seal is locked.");

  const state = await fetchSealState();
  const existing = await fetchSealedSnapshot();

  if (existing) {
    const payload = await unsealJson<SealedOutlinePayload>(dek, existing);
    return Array.isArray(payload.nodes) ? payload.nodes : [];
  }

  // One-shot migration: seal whatever plaintext remains, then wipe it.
  if (state.hasPlaintextNodes) {
    const nodes = await fetchPlaintextNodes();
    const envelope = await sealJson(dek, "snapshot", ++persistSeq, { nodes });
    await putSealedSnapshot(envelope);
    await appendRevision(envelope);
    await clearPlaintextOnServer();
    return nodes;
  }

  // Empty sealed outline (new account after seal setup).
  const empty = await sealJson(dek, "snapshot", ++persistSeq, { nodes: [] });
  await putSealedSnapshot(empty);
  await clearPlaintextOnServer();
  return [];
}

export async function persistSealedNodes(
  nodes: readonly Node[],
): Promise<void> {
  const dek = getSealDek();
  if (!dek) throw new Error("Seal is locked.");
  const envelope = await sealJson(dek, "snapshot", ++persistSeq, {
    nodes: [...nodes],
  });
  await putSealedSnapshot(envelope);
  await appendRevision(envelope);
}

/** Debounced persist for keystroke-heavy field edits. */
export function schedulePersistSealedNodes(nodes: readonly Node[]): void {
  const snapshot = [...nodes];
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    void persistSealedNodes(snapshot).catch((err) => {
      console.error("[seal] persist failed", err);
    });
  }, 400);
}

export async function flushPersistSealedNodes(
  nodes: readonly Node[],
): Promise<void> {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  await persistSealedNodes(nodes);
}
