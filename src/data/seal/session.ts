/**
 * In-memory seal session: holds the DEK until lock / sign-out (ADR 0063).
 * Optional "remember this device" wraps the DEK into localStorage (later).
 */

let dek: CryptoKey | null = null;
const listeners = new Set<() => void>();

export function getSealDek(): CryptoKey | null {
  return dek;
}

export function isSealUnlocked(): boolean {
  return dek !== null;
}

export function setSealDek(next: CryptoKey | null): void {
  dek = next;
  for (const l of listeners) l();
}

export function lockSeal(): void {
  setSealDek(null);
}

export function subscribeSealSession(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Clear seal on sign-out / hard reset. */
export function clearSealSession(): void {
  lockSeal();
}
