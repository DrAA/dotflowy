/**
 * Client → Worker seal storage (keybag + sealed snapshot). Opaque to the server.
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
};

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
  return (await res.json()) as SealStateResponse;
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
): Promise<void> {
  const res = await sealFetch("/api/seal/snapshot", {
    method: "PUT",
    body: JSON.stringify({ envelope }),
  });
  if (!res.ok) {
    throw new Error(`Couldn't save sealed snapshot (${res.status}).`);
  }
}

export async function fetchSealedSnapshot(): Promise<SealedEnvelope | null> {
  const res = await sealFetch("/api/seal/snapshot");
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`Couldn't load sealed snapshot (${res.status}).`);
  }
  const body = (await res.json()) as { envelope: SealedEnvelope | null };
  return body.envelope;
}
