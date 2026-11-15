/**
 * Sealed payload envelopes: snapshot or revision ciphertext (ADR 0063).
 */

import { decryptWithDek, encryptWithDek, SEAL_FORMAT_VERSION } from "./crypto";

export type SealedEnvelope = {
  v: typeof SEAL_FORMAT_VERSION;
  kind: "snapshot" | "revision";
  /** Monotonic seq from the sync cursor when this envelope was produced. */
  seq: number;
  iv: string;
  ciphertext: string;
};

export async function sealJson(
  dek: CryptoKey,
  kind: SealedEnvelope["kind"],
  seq: number,
  value: unknown,
): Promise<SealedEnvelope> {
  const plaintext = new TextEncoder().encode(JSON.stringify(value));
  const { iv, ciphertext } = await encryptWithDek(dek, plaintext);
  return { v: SEAL_FORMAT_VERSION, kind, seq, iv, ciphertext };
}

export async function unsealJson<T>(
  dek: CryptoKey,
  envelope: SealedEnvelope,
): Promise<T> {
  if (envelope.v !== SEAL_FORMAT_VERSION) {
    throw new Error(`Unsupported seal envelope version ${envelope.v}`);
  }
  const pt = await decryptWithDek(dek, envelope.iv, envelope.ciphertext);
  return JSON.parse(new TextDecoder().decode(pt)) as T;
}

export function parseEnvelope(json: string): SealedEnvelope {
  const parsed = JSON.parse(json) as SealedEnvelope;
  if (parsed.v !== SEAL_FORMAT_VERSION) {
    throw new Error(`Unsupported seal envelope version ${parsed.v}`);
  }
  if (parsed.kind !== "snapshot" && parsed.kind !== "revision") {
    throw new Error("Seal envelope kind must be snapshot or revision.");
  }
  if (typeof parsed.seq !== "number" || !parsed.iv || !parsed.ciphertext) {
    throw new Error("Seal envelope is incomplete.");
  }
  return parsed;
}
