/**
 * Seal image bytes for R2 upload / decrypt for display (ADR 0063).
 * Wire format: 12-byte IV || ciphertext (AES-GCM).
 */

import { base64UrlToBytes, bytesToBase64Url, concatBytes } from "./bytes";
import { decryptWithDek, encryptWithDek, IV_BYTES } from "./crypto";
import { getSealDek } from "./session";

/** Fresh ArrayBuffer-backed view for Blob / fetch BodyInit typing. */
function asArrayBufferView(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}

export async function sealMediaFile(
  file: File,
): Promise<Uint8Array<ArrayBuffer>> {
  const dek = getSealDek();
  if (!dek) throw new Error("Seal is locked.");
  const plaintext = new Uint8Array(await file.arrayBuffer());
  const { iv, ciphertext } = await encryptWithDek(dek, plaintext);
  return asArrayBufferView(
    concatBytes(base64UrlToBytes(iv), base64UrlToBytes(ciphertext)),
  );
}

export async function unsealMediaBytes(
  packed: Uint8Array,
): Promise<Uint8Array<ArrayBuffer>> {
  const dek = getSealDek();
  if (!dek) throw new Error("Seal is locked.");
  if (packed.byteLength < IV_BYTES + 1) {
    throw new Error("Sealed media blob is truncated.");
  }
  const iv = packed.subarray(0, IV_BYTES);
  const ct = packed.subarray(IV_BYTES);
  return asArrayBufferView(
    await decryptWithDek(dek, bytesToBase64Url(iv), bytesToBase64Url(ct)),
  );
}
