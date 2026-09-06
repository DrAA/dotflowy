# Runbook: content backup & restore (outline + images)

User-facing portable backup: a gzip JSON file
(`YYYY-MM-DD-aaflowy-backup.aaflowy-backup.json.gz`) with the whole outline,
side-collections, and **embedded image bytes**. Distinct from operator R2
snapshots ([offsite-backup-r2.md](./offsite-backup-r2.md)), which omit media
bytes (ADR 0061), and from PITR ([restore-user-pitr.md](./restore-user-pitr.md)).

## Download a backup

1. **Settings → Data → Backup (JSON) → Download**, or
2. **Cmd+K → “Download backup”**.

Save the file somewhere durable (disk, drive, off-site). Daily self-hosted
archives under `~/aai/aaflowy/backups/` are the same format (see
`deploy/archive-backup.sh`).

## Restore — whole outline

1. **Settings → Data → Restore backup → Restore…**, or **Cmd+K → “Restore backup…”**.
2. Choose the `.aaflowy-backup.json.gz` file.
3. Pick **Whole outline**.
4. Confirm **Replace outline**.

This replaces every bullet and side settings (tag colors, saved queries, daily
index, images). One **Cmd+Z** can undo the outline change.

## Restore — one bullet

Use this when only one branch was lost or corrupted.

1. Open the restore file picker the same way as above.
2. Pick **One bullet…**.
3. Search the backup and select the bullet to bring back.
4. Confirm **Restore bullet**.

That bullet and its **descendants** (plus their images) are merged into the
live outline. Everything else stays. If the bullet’s parent no longer exists,
it is attached under the current zoom root (or home). One **Cmd+Z** undoes it.

## Verify a backup file

A healthy backup:

- Gunzips to JSON with `version: 1`, `app: "aaflowy"`.
- Every `media` kv row has a matching entry in `blobs` (base64 image bytes).

Self-hosted check:

```sh
bun -e '
import { gunzipSync } from "zlib";
import { readFileSync } from "fs";
const j = JSON.parse(gunzipSync(readFileSync(process.argv[1])).toString());
const media = j.kv.filter((r) => r.collection === "media");
const missing = media.filter((r) => !j.blobs[r.value.id]);
console.log({ nodes: j.nodes.length, media: media.length, blobs: Object.keys(j.blobs).length, missing: missing.length });
' path/to/backup.aaflowy-backup.json.gz
```

## Related

| Path                                           | What it restores                                       |
| ---------------------------------------------- | ------------------------------------------------------ |
| This runbook                                   | User file: whole outline or one bullet + images        |
| [restore-user-pitr.md](./restore-user-pitr.md) | Operator: one user to a time within 30 days            |
| [offsite-backup-r2.md](./offsite-backup-r2.md) | Operator: daily R2 snapshot (nodes/kv, no image bytes) |
