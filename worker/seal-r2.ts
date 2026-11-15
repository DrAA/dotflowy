/// <reference types="@cloudflare/workers-types" />

/**
 * R2 key layout for sealed outline envelopes (ADR 0063).
 * Bulk ciphertext lives in BACKUPS; the DO only stores small meta flags.
 */

export const SEAL_REV_KEEP = 32;

/** Live sealed snapshot for one account. */
export function sealSnapshotKey(userId: string): string {
  return `seal/${userId}/snapshot`;
}

/** Prefix for append-only sealed revision objects. */
export function sealRevPrefix(userId: string): string {
  return `seal/${userId}/rev/`;
}

export function sealRevKey(userId: string, seq: number): string {
  // Zero-pad so lexicographic list order matches seq order.
  return `${sealRevPrefix(userId)}${String(seq).padStart(16, "0")}`;
}

/** Drop oldest revision objects until at most `keep` remain. */
export async function pruneSealRevisions(
  bucket: R2Bucket,
  userId: string,
  keep: number = SEAL_REV_KEEP,
): Promise<void> {
  const prefix = sealRevPrefix(userId);
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const listed = await bucket.list({ prefix, cursor, limit: 1000 });
    for (const obj of listed.objects) keys.push(obj.key);
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
  keys.sort();
  if (keys.length <= keep) return;
  const drop = keys.slice(0, keys.length - keep);
  await Promise.all(drop.map((key) => bucket.delete(key)));
}
