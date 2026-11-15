/**
 * Optional "remember this device" — wrap the DEK with a browser-local secret
 * (ADR 0063). Scoped per userId so account switches cannot unlock the wrong
 * outline. Clearing site data forgets the device.
 */

import { bytesToBase64Url } from "./bytes";
import {
  decryptWithSecret,
  encryptWithSecret,
  exportDekRaw,
  importDekRaw,
  randomBytes,
} from "./crypto";
import { getSealDek, setSealDek } from "./session";

const DEVICE_SECRET_KEY = "dotflowy:seal:device-secret";

function wrapKey(userId: string): string {
  return `dotflowy:seal:device-wrap:${userId}`;
}

function getOrCreateDeviceSecret(): string {
  try {
    let s = window.localStorage.getItem(DEVICE_SECRET_KEY);
    if (!s) {
      s = bytesToBase64Url(randomBytes(32));
      window.localStorage.setItem(DEVICE_SECRET_KEY, s);
    }
    return s;
  } catch {
    throw new Error("Couldn't access local storage for remember-device.");
  }
}

/** Persist the current in-memory DEK for this browser + user. */
export async function rememberSealOnDevice(userId: string): Promise<void> {
  const dek = getSealDek();
  if (!dek) throw new Error("Seal is locked.");
  const raw = await exportDekRaw(dek);
  const wrap = await encryptWithSecret(getOrCreateDeviceSecret(), raw);
  window.localStorage.setItem(wrapKey(userId), JSON.stringify(wrap));
}

export function forgetSealOnDevice(userId: string): void {
  try {
    window.localStorage.removeItem(wrapKey(userId));
  } catch {
    // ignore
  }
}

/** Try to restore DEK from this device wrap. Returns true if unlocked. */
export async function tryUnlockFromDevice(userId: string): Promise<boolean> {
  try {
    const rawWrap = window.localStorage.getItem(wrapKey(userId));
    if (!rawWrap) return false;
    const wrap = JSON.parse(rawWrap) as {
      salt: string;
      iv: string;
      ciphertext: string;
    };
    const secret = window.localStorage.getItem(DEVICE_SECRET_KEY);
    if (!secret) return false;
    const raw = await decryptWithSecret(secret, wrap);
    setSealDek(await importDekRaw(raw));
    return true;
  } catch {
    forgetSealOnDevice(userId);
    return false;
  }
}
