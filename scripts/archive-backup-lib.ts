/**
 * Pure helpers for the daily ~/aai/aaflowy/backups archive cron
 * (scripts/archive-backup.ts). Converts operator R2 snapshots
 * (worker/backup.ts — nodes + kv metadata, no image bytes per ADR 0061)
 * into the user-facing content-backup shape (src/data/content-backup.ts)
 * by embedding media fetched separately from the MEDIA R2 bucket.
 */

import type { OutlineSnapshot, SnapshotKvRow } from "../worker/backup";

import { backupKeyForDate, utcDateKey } from "../worker/backup";

/** Matches src/data/content-backup.ts — keep in sync manually. */
export const CONTENT_BACKUP_VERSION = 1;

export const BACKUP_FILE_EXT = ".aaflowy-backup.json.gz";

/** Archive filenames: `YYYY-MM-DD-aaflowy-backup.aaflowy-backup.json.gz`. */
export const ARCHIVE_FILENAME_RE =
  /^(\d{4}-\d{2}-\d{2})-aaflowy-backup\.aaflowy-backup\.json\.gz$/;

export type ContentBackupBlob = {
  contentType: string;
  base64: string;
};

export type ContentBackupKvRow = {
  collection: string;
  key: string;
  value: unknown;
};

/** On-disk backup JSON (gzip wrapper applied separately). */
export type ContentBackupPayload = {
  version: typeof CONTENT_BACKUP_VERSION;
  exportedAt: number;
  app: "aaflowy";
  nodes: OutlineSnapshot["nodes"];
  kv: ContentBackupKvRow[];
  blobs: Record<string, ContentBackupBlob>;
};

export type MediaRowRef = {
  id: string;
  nodeId: string;
  contentType: string;
};

/** UTC date slug for backup filenames (`YYYY-MM-DD-aaflowy-backup`). */
export function backupDateKey(at = Date.now()): string {
  return utcDateKey(at);
}

export function backupFilename(at = Date.now()): string {
  return `${backupDateKey(at)}-aaflowy-backup${BACKUP_FILE_EXT}`;
}

/** R2 object key for one DO's operator snapshot on a calendar date. */
export function snapshotR2Key(doName: string, date: string): string {
  return backupKeyForDate(doName, date);
}

/** R2 object key for hosted image bytes (worker/media.ts). */
export function mediaR2Key(userId: string, attachmentId: string): string {
  return `media/${userId}/${attachmentId}`;
}

/**
 * Map a DO export name to the Better Auth user id used in media R2 keys.
 * The owner bridge stores outline data under `default` but media under
 * `OWNER_USER_ID`.
 */
export function resolveMediaUserId(
  doName: string,
  ownerUserId: string | undefined,
): string {
  if (doName === "default" && ownerUserId) return ownerUserId;
  return doName;
}

/** Pick the DO snapshot to archive — prefer the export with the most nodes. */
export function resolveArchiveDoName(
  exported: readonly { doName: string; nodes: number }[],
  explicitDoName: string,
): string {
  if (!exported.length) return explicitDoName;
  const best = exported.reduce((a, row) => (row.nodes > a.nodes ? row : a));
  const preferred = exported.find((row) => row.doName === explicitDoName);
  if (preferred && preferred.nodes === best.nodes) return explicitDoName;
  return best.doName;
}

/** Base64-encode raw bytes (no data-URL prefix). */
export function encodeBlobBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

/** Parse media metadata rows from a snapshot's kv table. */
export function mediaRowsFromSnapshotKv(
  kv: readonly SnapshotKvRow[],
): MediaRowRef[] {
  const out: MediaRowRef[] = [];
  for (const row of kv) {
    if (row.collection !== "media") continue;
    let value: unknown;
    try {
      value = JSON.parse(row.value);
    } catch {
      continue;
    }
    if (!value || typeof value !== "object") continue;
    const record = value as Record<string, unknown>;
    if (typeof record.id !== "string" || typeof record.nodeId !== "string") {
      continue;
    }
    out.push({
      id: record.id,
      nodeId: record.nodeId,
      contentType:
        typeof record.contentType === "string"
          ? record.contentType
          : "application/octet-stream",
    });
  }
  return out;
}

/** Operator snapshot → portable content backup (blobs supplied separately). */
export function snapshotToContentBackup(
  snapshot: OutlineSnapshot,
  blobs: Record<string, ContentBackupBlob>,
): ContentBackupPayload {
  return {
    version: CONTENT_BACKUP_VERSION,
    exportedAt: snapshot.exportedAt,
    app: "aaflowy",
    nodes: snapshot.nodes,
    kv: snapshot.kv.map((row) => ({
      collection: row.collection,
      key: row.key,
      value: JSON.parse(row.value) as unknown,
    })),
    blobs,
  };
}

/** Extract unique UTC dates from archive filenames, newest first. */
export function sortedBackupDates(filenames: readonly string[]): string[] {
  const dates = new Set<string>();
  for (const name of filenames) {
    const match = ARCHIVE_FILENAME_RE.exec(name);
    if (match?.[1]) dates.add(match[1]);
  }
  return [...dates].sort((a, b) => b.localeCompare(a));
}

/**
 * Given archive filenames already on disk, return calendar dates whose files
 * should be deleted to honor `keepCount` most-recent date-based backups.
 */
export function backupDatesToDelete(
  filenames: readonly string[],
  keepCount = 3,
): string[] {
  return sortedBackupDates(filenames).slice(keepCount);
}

/** Filenames in `dir` matching the archive naming convention. */
export function archiveFilenamesForDate(
  filenames: readonly string[],
  date: string,
): string[] {
  return filenames.filter((name) => name.startsWith(`${date}-aaflowy-backup`));
}
