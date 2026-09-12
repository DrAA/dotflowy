/**
 * Per-user at-rest encryption for outline Durable Object storage.
 *
 * Model (self-hosted / operator-held master):
 *  - `AT_REST_MASTER_KEY` (32-byte base64) lives in Worker/DO env secrets.
 *  - Each DO (one per user) has its own random AES-256 **DEK**, wrapped with a
 *    KEK derived via HKDF(master, doName) and stored in DO `meta`.
 *  - After auth, the Worker only routes to that user's DO; the DO unwraps its
 *    DEK into memory and seals/unseals payloads with SubtleCrypto (AES-GCM).
 *  - Disk holds ciphertext (`enc1.…` prefix). No key → no plaintext.
 *
 * This is NOT end-to-end encryption: the server must decrypt to sync/render.
 * It IS per-user isolation at rest (user A's DEK cannot read user B's rows)
 * and protects cold filesystem copies when the master key is absent.
 */

export const ENC_PREFIX = "enc1.";

const HKDF_SALT = new TextEncoder().encode("dotflowy-at-rest-v1");
const WRAP_INFO = new TextEncoder().encode("dek-wrap");

export type AtRestKeySource = {
  /** Raw 32-byte master key (already decoded). */
  masterRaw: ArrayBuffer;
  /** Durable Object name / user scope id used as HKDF info. */
  doName: string;
};

function b64urlEncode(bytes: ArrayBuffer | Uint8Array): string {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]!);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): Uint8Array {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const b64 = (s + pad).replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Decode `AT_REST_MASTER_KEY` from base64 / base64url. Returns null if unset. */
export function parseMasterKey(
  raw: string | undefined | null,
): ArrayBuffer | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  try {
    const bytes = b64urlDecode(trimmed.replace(/\+/g, "-").replace(/\//g, "_"));
    if (bytes.byteLength !== 32) return null;
    const copy = new Uint8Array(32);
    copy.set(bytes);
    return copy.buffer;
  } catch {
    return null;
  }
}

export function isSealed(value: string): boolean {
  return value.startsWith(ENC_PREFIX);
}

async function importHkdfKey(masterRaw: ArrayBuffer): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", masterRaw, "HKDF", false, [
    "deriveBits",
    "deriveKey",
  ]);
}

/** KEK unique to this DO/user, derived from the master. */
export async function deriveKek(
  masterRaw: ArrayBuffer,
  doName: string,
): Promise<CryptoKey> {
  const base = await importHkdfKey(masterRaw);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: HKDF_SALT,
      info: new TextEncoder().encode(`kek:${doName}`),
    },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function generateDek(): Promise<CryptoKey> {
  const key = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"],
  );
  return key as CryptoKey;
}

/** Wrap a DEK for storage in DO meta (ciphertext string). */
export async function wrapDek(
  dek: CryptoKey,
  kek: CryptoKey,
): Promise<string> {
  const exported = await crypto.subtle.exportKey("raw", dek);
  const raw = new Uint8Array(exported as ArrayBuffer);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, kek, raw),
  );
  const packed = new Uint8Array(iv.length + ct.length);
  packed.set(iv, 0);
  packed.set(ct, iv.length);
  return ENC_PREFIX + b64urlEncode(packed);
}

export async function unwrapDek(
  wrapped: string,
  kek: CryptoKey,
): Promise<CryptoKey> {
  if (!isSealed(wrapped)) {
    throw new Error("at-rest: wrapped DEK missing enc1. prefix");
  }
  const packed = b64urlDecode(wrapped.slice(ENC_PREFIX.length));
  if (packed.byteLength < 13) throw new Error("at-rest: wrapped DEK too short");
  const iv = packed.subarray(0, 12);
  const ct = packed.subarray(12);
  const raw = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, kek, ct);
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, true, [
    "encrypt",
    "decrypt",
  ]);
}

/** Seal a UTF-8 string with the per-user DEK. Idempotent on already-sealed. */
export async function sealString(
  plaintext: string,
  dek: CryptoKey,
): Promise<string> {
  if (isSealed(plaintext)) return plaintext;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      dek,
      new TextEncoder().encode(plaintext),
    ),
  );
  const packed = new Uint8Array(iv.length + ct.length);
  packed.set(iv, 0);
  packed.set(ct, iv.length);
  return ENC_PREFIX + b64urlEncode(packed);
}

/** Unseal; plaintext passthrough if no prefix (legacy rows). */
export async function unsealString(
  value: string,
  dek: CryptoKey,
): Promise<string> {
  if (!isSealed(value)) return value;
  const packed = b64urlDecode(value.slice(ENC_PREFIX.length));
  if (packed.byteLength < 13) throw new Error("at-rest: ciphertext too short");
  const iv = packed.subarray(0, 12);
  const ct = packed.subarray(12);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, dek, ct);
  return new TextDecoder().decode(pt);
}

/** Seal a whole JSON snapshot for cold storage (R2 / archive). */
export async function sealColdBlob(
  jsonText: string,
  dek: CryptoKey,
): Promise<string> {
  return sealString(jsonText, dek);
}

export async function unsealColdBlob(
  blob: string,
  dek: CryptoKey,
): Promise<string> {
  return unsealString(blob, dek);
}

/** Unused export kept so wrap info stays discoverable in tests/docs. */
export const _WRAP_INFO = WRAP_INFO;
