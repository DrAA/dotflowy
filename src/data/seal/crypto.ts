/**
 * Web Crypto primitives for sealed outlines (ADR 0063).
 * Passphrase → PBKDF2-SHA-256 → AES-GCM. Never sends secrets to the server.
 */

import { base64UrlToBytes, bytesToBase64Url } from "./bytes";

export const SEAL_FORMAT_VERSION = 1;
export const PBKDF2_ITERATIONS = 600_000;
export const SALT_BYTES = 16;
export const IV_BYTES = 12;
export const DEK_BYTES = 32;

export type AesGcmBlob = {
  salt: string;
  iv: string;
  ciphertext: string;
};

function requireSubtle(): SubtleCrypto {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new Error("Web Crypto SubtleCrypto is not available.");
  return s;
}

/** Copy into a fresh ArrayBuffer-backed view (TS DOM BufferSource typing). */
function asBufferSource(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}

export function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  globalThis.crypto.getRandomValues(out);
  return out;
}

async function importPbkdf2Key(secret: Uint8Array): Promise<CryptoKey> {
  return requireSubtle().importKey(
    "raw",
    asBufferSource(secret),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
}

/** Derive an AES-GCM key from a UTF-8 secret + salt. */
export async function deriveAesGcmKey(
  secretUtf8: string,
  salt: Uint8Array,
  iterations = PBKDF2_ITERATIONS,
): Promise<CryptoKey> {
  const subtle = requireSubtle();
  const secret = new TextEncoder().encode(secretUtf8);
  const base = await importPbkdf2Key(secret);
  return subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: asBufferSource(salt),
      iterations,
      hash: "SHA-256",
    },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function importDekRaw(raw: Uint8Array): Promise<CryptoKey> {
  // extractable: rewrapPassphrase must export the DEK after recovery unlock.
  return requireSubtle().importKey(
    "raw",
    asBufferSource(raw),
    { name: "AES-GCM" },
    true,
    ["encrypt", "decrypt"],
  );
}

export async function exportDekRaw(dek: CryptoKey): Promise<Uint8Array> {
  const raw = await requireSubtle().exportKey("raw", dek);
  return new Uint8Array(raw);
}

export async function generateDek(): Promise<CryptoKey> {
  return requireSubtle().generateKey({ name: "AES-GCM", length: 256 }, true, [
    "encrypt",
    "decrypt",
  ]);
}

/** Encrypt bytes with a raw secret (passphrase or recovery key string). */
export async function encryptWithSecret(
  secretUtf8: string,
  plaintext: Uint8Array,
): Promise<AesGcmBlob> {
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const key = await deriveAesGcmKey(secretUtf8, salt);
  const ct = await requireSubtle().encrypt(
    { name: "AES-GCM", iv: asBufferSource(iv) },
    key,
    asBufferSource(plaintext),
  );
  return {
    salt: bytesToBase64Url(salt),
    iv: bytesToBase64Url(iv),
    ciphertext: bytesToBase64Url(new Uint8Array(ct)),
  };
}

export async function decryptWithSecret(
  secretUtf8: string,
  blob: AesGcmBlob,
): Promise<Uint8Array> {
  const salt = base64UrlToBytes(blob.salt);
  const iv = base64UrlToBytes(blob.iv);
  const ct = base64UrlToBytes(blob.ciphertext);
  const key = await deriveAesGcmKey(secretUtf8, salt);
  const pt = await requireSubtle().decrypt(
    { name: "AES-GCM", iv: asBufferSource(iv) },
    key,
    asBufferSource(ct),
  );
  return new Uint8Array(pt);
}

/** Encrypt bytes with an already-imported DEK (snapshot / revision payloads). */
export async function encryptWithDek(
  dek: CryptoKey,
  plaintext: Uint8Array,
): Promise<{ iv: string; ciphertext: string }> {
  const iv = randomBytes(IV_BYTES);
  const ct = await requireSubtle().encrypt(
    { name: "AES-GCM", iv: asBufferSource(iv) },
    dek,
    asBufferSource(plaintext),
  );
  return {
    iv: bytesToBase64Url(iv),
    ciphertext: bytesToBase64Url(new Uint8Array(ct)),
  };
}

export async function decryptWithDek(
  dek: CryptoKey,
  ivB64: string,
  ciphertextB64: string,
): Promise<Uint8Array> {
  const iv = base64UrlToBytes(ivB64);
  const ct = base64UrlToBytes(ciphertextB64);
  const pt = await requireSubtle().decrypt(
    { name: "AES-GCM", iv: asBufferSource(iv) },
    dek,
    asBufferSource(ct),
  );
  return new Uint8Array(pt);
}
