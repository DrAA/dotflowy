/**
 * Seal keybag: DEK wrapped by passphrase and by recovery key (ADR 0063).
 * The keybag JSON is safe to store on the server — it is not the DEK.
 */

import { bytesToBase64Url } from "./bytes";
import {
  decryptWithSecret,
  encryptWithSecret,
  exportDekRaw,
  generateDek,
  importDekRaw,
  PBKDF2_ITERATIONS,
  randomBytes,
  SEAL_FORMAT_VERSION,
  type AesGcmBlob,
} from "./crypto";

export type SealKeybag = {
  v: typeof SEAL_FORMAT_VERSION;
  kdf: "PBKDF2-SHA-256";
  iterations: number;
  passphraseWrap: AesGcmBlob;
  recoveryWrap: AesGcmBlob;
};

export type CreateSealResult = {
  keybag: SealKeybag;
  dek: CryptoKey;
  /** Show once — never stored on the server. */
  recoveryKey: string;
};

const RECOVERY_PREFIX = "dfseal1_";

/** Generate a recovery key the user must save offline. */
export function generateRecoveryKey(): string {
  return RECOVERY_PREFIX + bytesToBase64Url(randomBytes(32));
}

export function isRecoveryKeyFormat(s: string): boolean {
  return (
    s.startsWith(RECOVERY_PREFIX) && s.length > RECOVERY_PREFIX.length + 20
  );
}

export async function createSeal(
  passphrase: string,
): Promise<CreateSealResult> {
  if (passphrase.length < 8) {
    throw new Error("Seal passphrase must be at least 8 characters.");
  }
  const dek = await generateDek();
  const raw = await exportDekRaw(dek);
  const recoveryKey = generateRecoveryKey();
  const passphraseWrap = await encryptWithSecret(passphrase, raw);
  const recoveryWrap = await encryptWithSecret(recoveryKey, raw);
  const keybag: SealKeybag = {
    v: SEAL_FORMAT_VERSION,
    kdf: "PBKDF2-SHA-256",
    iterations: PBKDF2_ITERATIONS,
    passphraseWrap,
    recoveryWrap,
  };
  return { keybag, dek, recoveryKey };
}

export async function unlockWithPassphrase(
  keybag: SealKeybag,
  passphrase: string,
): Promise<CryptoKey> {
  assertKeybag(keybag);
  const raw = await decryptWithSecret(passphrase, keybag.passphraseWrap);
  return importDekRaw(raw);
}

export async function unlockWithRecoveryKey(
  keybag: SealKeybag,
  recoveryKey: string,
): Promise<CryptoKey> {
  assertKeybag(keybag);
  if (!isRecoveryKeyFormat(recoveryKey)) {
    throw new Error("That does not look like a Dotflowy recovery key.");
  }
  const raw = await decryptWithSecret(recoveryKey, keybag.recoveryWrap);
  return importDekRaw(raw);
}

/** After recovery unlock, set a new passphrase (rewrap passphrase side only). */
export async function rewrapPassphrase(
  keybag: SealKeybag,
  dek: CryptoKey,
  newPassphrase: string,
): Promise<SealKeybag> {
  if (newPassphrase.length < 8) {
    throw new Error("Seal passphrase must be at least 8 characters.");
  }
  assertKeybag(keybag);
  const raw = await exportDekRaw(dek);
  const passphraseWrap = await encryptWithSecret(newPassphrase, raw);
  return { ...keybag, passphraseWrap };
}

function assertKeybag(keybag: SealKeybag): void {
  if (keybag.v !== SEAL_FORMAT_VERSION) {
    throw new Error(`Unsupported seal keybag version ${keybag.v}`);
  }
  if (!keybag.passphraseWrap?.ciphertext || !keybag.recoveryWrap?.ciphertext) {
    throw new Error("Seal keybag is incomplete.");
  }
}

export function parseKeybag(json: string): SealKeybag {
  const parsed = JSON.parse(json) as SealKeybag;
  assertKeybag(parsed);
  return parsed;
}
