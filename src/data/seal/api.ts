/**
 * Client → Worker seal storage (keybag + sealed snapshot + revisions).
 * Opaque to the server (ADR 0063 / 0064).
 */

import type { SealedEnvelope } from "./envelope";
import type { SealKeybag } from "./keybag";

export type SealStateResponse = {
  keybag: SealKeybag | null;
  /** True when a sealed snapshot is stored on the DO. */
  hasSealedSnapshot: boolean;
  /** True when the DO still has plaintext nodes (pre-migration or flag off path). */
  hasPlaintextNodes: boolean;
  /** True after clear-plaintext — live sync must use sealed envelopes. */
  sealActive: boolean;
  /** OCC token for the live snapshot (0 = never written). */
  snapshotSeq: number;
  /** Rev-seq watermark of the live snapshot (pull after this on unlock). */
  snapshotAtRev: number;
  /** Highest allocated sealed revision seq (0 = none). */
  revSeq: number;
};

export class SealSnapshotConflictError extends Error {
  readonly snapshotSeq: number;
  constructor(snapshotSeq: number) {
    super(`Sealed snapshot conflict (server seq ${snapshotSeq}).`);
    this.name = "SealSnapshotConflictError";
    this.snapshotSeq = snapshotSeq;
  }
}

async function sealFetch(path: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(path, {
    credentials: "include",
    ...init,
    headers: {
      "content-type": "application/json",
      ...init?.headers,
    },
  });
  return res;
}

export async function fetchSealState(): Promise<SealStateResponse> {
  const res = await sealFetch("/api/seal");
  if (!res.ok) {
    throw new Error(`Couldn't load seal state (${res.status}).`);
  }
  const body = (await res.json()) as Partial<SealStateResponse>;
  return {
    keybag: (body.keybag as SealKeybag | null) ?? null,
    hasSealedSnapshot: Boolean(body.hasSealedSnapshot),
    hasPlaintextNodes: Boolean(body.hasPlaintextNodes),
    sealActive: Boolean(body.sealActive),
    snapshotSeq:
      typeof body.snapshotSeq === "number" && Number.isFinite(body.snapshotSeq)
        ? body.snapshotSeq
        : 0,
    snapshotAtRev:
      typeof body.snapshotAtRev === "number" &&
      Number.isFinite(body.snapshotAtRev)
        ? body.snapshotAtRev
        : 0,
    revSeq:
      typeof body.revSeq === "number" && Number.isFinite(body.revSeq)
        ? body.revSeq
        : 0,
  };
}

export async function putSealKeybag(keybag: SealKeybag): Promise<void> {
  const res = await sealFetch("/api/seal/keybag", {
    method: "PUT",
    body: JSON.stringify({ keybag }),
  });
  if (!res.ok) {
    throw new Error(`Couldn't save seal keybag (${res.status}).`);
  }
}

export async function putSealedSnapshot(
  envelope: SealedEnvelope,
  expectedSeq: number,
): Promise<number> {
  const res = await sealFetch("/api/seal/snapshot", {
    method: "PUT",
    body: JSON.stringify({ envelope, expectedSeq }),
  });
  if (res.status === 409) {
    let seq = expectedSeq;
    try {
      const body = (await res.json()) as { snapshotSeq?: number };
      if (typeof body.snapshotSeq === "number") seq = body.snapshotSeq;
    } catch {
      // empty body — keep expectedSeq as a lower bound
    }
    throw new SealSnapshotConflictError(seq);
  }
  if (!res.ok) {
    throw new Error(`Couldn't save sealed snapshot (${res.status}).`);
  }
  const body = (await res.json()) as { snapshotSeq?: number };
  if (
    typeof body.snapshotSeq === "number" &&
    Number.isFinite(body.snapshotSeq)
  ) {
    return body.snapshotSeq;
  }
  return expectedSeq + 1;
}

export async function fetchSealedSnapshot(): Promise<{
  envelope: SealedEnvelope | null;
  snapshotSeq: number;
  snapshotAtRev: number;
}> {
  const res = await sealFetch("/api/seal/snapshot");
  if (res.status === 404) {
    let snapshotSeq = 0;
    let snapshotAtRev = 0;
    try {
      const body = (await res.json()) as {
        snapshotSeq?: number;
        snapshotAtRev?: number;
      };
      if (typeof body.snapshotSeq === "number") snapshotSeq = body.snapshotSeq;
      if (typeof body.snapshotAtRev === "number")
        snapshotAtRev = body.snapshotAtRev;
    } catch {
      // ignore
    }
    return { envelope: null, snapshotSeq, snapshotAtRev };
  }
  if (!res.ok) {
    throw new Error(`Couldn't load sealed snapshot (${res.status}).`);
  }
  const body = (await res.json()) as {
    envelope: SealedEnvelope | null;
    snapshotSeq?: number;
    snapshotAtRev?: number;
  };
  return {
    envelope: body.envelope,
    snapshotSeq:
      typeof body.snapshotSeq === "number" && Number.isFinite(body.snapshotSeq)
        ? body.snapshotSeq
        : 0,
    snapshotAtRev:
      typeof body.snapshotAtRev === "number" &&
      Number.isFinite(body.snapshotAtRev)
        ? body.snapshotAtRev
        : 0,
  };
}

export type SealRevisionPullItem = {
  seq: number;
  envelope: SealedEnvelope;
};

export async function fetchSealRevisionsAfter(
  after: number,
): Promise<{ revisions: SealRevisionPullItem[]; revSeq: number }> {
  const res = await sealFetch(`/api/seal/revisions?after=${after}`);
  if (!res.ok) {
    throw new Error(`Couldn't load sealed revisions (${res.status}).`);
  }
  const body = (await res.json()) as {
    revisions?: Array<{ seq: number; envelope: SealedEnvelope }>;
    revSeq?: number;
  };
  return {
    revisions: Array.isArray(body.revisions) ? body.revisions : [],
    revSeq:
      typeof body.revSeq === "number" && Number.isFinite(body.revSeq)
        ? body.revSeq
        : after,
  };
}

export async function postSealRevision(
  envelope: SealedEnvelope,
): Promise<number> {
  const res = await sealFetch("/api/seal/revisions", {
    method: "POST",
    body: JSON.stringify({ envelope }),
  });
  if (!res.ok) {
    throw new Error(`Couldn't append sealed revision (${res.status}).`);
  }
  const body = (await res.json()) as { revSeq?: number };
  if (typeof body.revSeq === "number" && Number.isFinite(body.revSeq)) {
    return body.revSeq;
  }
  return 0;
}
