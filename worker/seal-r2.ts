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

export type SealRevisionListItem = {
  seq: number;
  envelope: unknown;
};

/**
 * Load sealed revision envelopes with seq > `after`, in ascending seq order.
 * Used by live multi-writer pull (ADR 0064).
 */
export async function listSealRevisionsAfter(
  bucket: R2Bucket,
  userId: string,
  after: number,
  limit: number = SEAL_REV_KEEP,
): Promise<SealRevisionListItem[]> {
  const prefix = sealRevPrefix(userId);
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const listed = await bucket.list({ prefix, cursor, limit: 1000 });
    for (const obj of listed.objects) keys.push(obj.key);
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
  keys.sort();
  const out: SealRevisionListItem[] = [];
  for (const key of keys) {
    const seqStr = key.slice(prefix.length);
    const seq = Number.parseInt(seqStr, 10);
    if (!Number.isFinite(seq) || seq <= after) continue;
    const obj = await bucket.get(key);
    if (!obj) continue;
    const raw = await obj.text();
    try {
      out.push({ seq, envelope: JSON.parse(raw) as unknown });
    } catch {
      // Skip corrupt revision objects rather than failing the whole pull.
      continue;
    }
    if (out.length >= limit) break;
  }
  return out;
}
