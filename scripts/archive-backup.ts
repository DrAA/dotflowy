#!/usr/bin/env bun
import { Schema } from "effect";
/**
 * Daily archive backup for self-hosted aaflowy instances.
 *
 * Flow:
 *   1. (optional) Fire the Worker's scheduled backup sweep so today's operator
 *      snapshot exists in R2 (`runBackupSweep` in worker/index.ts).
 *   2. Read `backups/<doName>/<YYYY-MM-DD>.json` from the BACKUPS bucket.
 *   3. Fetch hosted image bytes from the MEDIA bucket and embed them as base64
 *      blobs — producing the same gzip JSON shape as the browser export
 *      (src/data/content-backup.ts), including images when R2 still has them.
 *   4. Write `YYYY-MM-DD-aaflowy-backup.aaflowy-backup.json.gz` to the archive
 *      directory (default `~/aai/aaflowy/backups`).
 *   5. Delete archives older than the three most recent calendar dates.
 *
 * Requires: bun, wrangler (via bunx), a running local Worker, and Cloudflare
 * credentials when `--remote`. Set OWNER_USER_ID in `.dev.vars` so the owner's
 * pre-auth outline in the `default` DO is swept (see deploy/archive-backup.sh).
 *
 * Usage:
 *   bun scripts/archive-backup.ts
 *   bun scripts/archive-backup.ts --dry-run --archive-dir /tmp/aaflowy-archives
 *   bun scripts/archive-backup.ts --skip-sweep --date 2026-08-26
 *
 * Environment (all optional):
 *   AAFLOWY_ARCHIVE_DIR      output directory (default ~/aai/aaflowy/backups)
 *   AAFLOWY_DO_NAME          DO export name (default default)
 *   AAFLOWY_MEDIA_USER_ID    Better Auth id for media R2 keys (else .dev.vars)
 *   AAFLOWY_OWNER_USER_ID    alias for media user id when DO is default
 *   AAFLOWY_WORKER_URL       sweep trigger URL (default http://127.0.0.1:7777)
 *   AAFLOWY_PERSIST_TO       wrangler local state dir (default .wrangler/state)
 *   AAFLOWY_R2_MODE          local | remote (default local)
 *   AAFLOWY_RETENTION        number of date-based backups to keep (default 3)
 */
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { gzipSync } from "node:zlib";

import { OutlineSnapshotSchema, utcDateKey } from "../worker/backup";
import { mediaR2Key } from "../worker/media";
import {
  type ContentBackupBlob,
  archiveFilenamesForDate,
  backupDatesToDelete,
  backupFilename,
  encodeBlobBase64,
  mediaRowsFromSnapshotKv,
  resolveArchiveDoName,
  resolveMediaUserId,
  snapshotR2Key,
  snapshotToContentBackup,
} from "./archive-backup-lib";

const ROOT = resolve(import.meta.dir, "..");
const DEV_VARS = resolve(ROOT, ".dev.vars");
const BACKUPS_BUCKET = "dotflowy-backups";
const MEDIA_BUCKET = "dotflowy-media";

const decodeSnapshot = Schema.decodeUnknownSync(OutlineSnapshotSchema);

type CliOptions = {
  archiveDir: string;
  doName: string;
  mediaUserId: string | undefined;
  workerUrl: string;
  persistTo: string;
  r2Mode: "local" | "remote";
  retention: number;
  date: string;
  dryRun: boolean;
  skipSweep: boolean;
};

function log(msg: string): void {
  console.log(`[archive-backup] ${msg}`);
}

function parseArgs(argv: readonly string[]): CliOptions {
  let archiveDir =
    process.env.AAFLOWY_ARCHIVE_DIR ??
    `${process.env.HOME ?? "/home/mrx"}/aai/aaflowy/backups`;
  let doName = process.env.AAFLOWY_DO_NAME ?? "default";
  let mediaUserId =
    process.env.AAFLOWY_MEDIA_USER_ID ??
    process.env.AAFLOWY_OWNER_USER_ID ??
    undefined;
  let workerUrl = process.env.AAFLOWY_WORKER_URL ?? "http://127.0.0.1:7777";
  let persistTo = process.env.AAFLOWY_PERSIST_TO ?? ".wrangler/state";
  let r2Mode: "local" | "remote" =
    process.env.AAFLOWY_R2_MODE === "remote" ? "remote" : "local";
  let retention = Number.parseInt(process.env.AAFLOWY_RETENTION ?? "3", 10);
  let date = utcDateKey(Date.now());
  let dryRun = false;
  let skipSweep = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--archive-dir":
        archiveDir = argv[++i] ?? archiveDir;
        break;
      case "--do-name":
        doName = argv[++i] ?? doName;
        break;
      case "--media-user-id":
        mediaUserId = argv[++i];
        break;
      case "--worker-url":
        workerUrl = argv[++i] ?? workerUrl;
        break;
      case "--persist-to":
        persistTo = argv[++i] ?? persistTo;
        break;
      case "--remote":
        r2Mode = "remote";
        break;
      case "--local":
        r2Mode = "local";
        break;
      case "--retention":
        retention = Number.parseInt(argv[++i] ?? "3", 10);
        break;
      case "--date":
        date = argv[++i] ?? date;
        break;
      case "--dry-run":
        dryRun = true;
        break;
      case "--skip-sweep":
        skipSweep = true;
        break;
      case "--help":
      case "-h":
        console.log("Usage: bun scripts/archive-backup.ts [options]");
        console.log(
          "Run `bun scripts/archive-backup.ts` with no args for defaults.",
        );
        console.log("See the file header for env vars and flags.");
        process.exit(0);
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }

  if (!Number.isFinite(retention) || retention < 1) {
    throw new Error("retention must be a positive integer");
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`date must be YYYY-MM-DD, got ${date}`);
  }

  return {
    archiveDir: resolve(archiveDir),
    doName,
    mediaUserId,
    workerUrl,
    persistTo: resolve(ROOT, persistTo),
    r2Mode,
    retention,
    date,
    dryRun,
    skipSweep,
  };
}

/** Read OWNER_USER_ID from `.dev.vars` when present. */
function ownerUserIdFromDevVars(): string | undefined {
  return devVar("OWNER_USER_ID");
}

/** Read ARCHIVE_SWEEP_SECRET from `.dev.vars` when present. */
function archiveSweepSecretFromDevVars(): string | undefined {
  return devVar("ARCHIVE_SWEEP_SECRET");
}

function devVar(name: string): string | undefined {
  try {
    const raw = readFileSync(DEV_VARS, "utf8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const prefix = `${name}=`;
      if (trimmed.startsWith(prefix)) {
        const value = trimmed.slice(prefix.length).trim();
        return value.length > 0 ? value : undefined;
      }
    }
  } catch {
    // optional
  }
  return undefined;
}

async function triggerBackupSweep(
  workerUrl: string,
  sweepSecret: string | undefined,
): Promise<{ doName: string; nodes: number; kv: number }[]> {
  const url = `${workerUrl.replace(/\/$/, "")}/api/local/backup-sweep`;
  log(`triggering operator backup sweep: POST ${url}`);
  const headers: Record<string, string> = {};
  if (sweepSecret) headers["x-archive-sweep-secret"] = sweepSecret;
  const res = await fetch(url, {
    method: "POST",
    headers,
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) {
    throw new Error(
      `backup sweep failed: HTTP ${res.status} ${res.statusText}`,
    );
  }
  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    throw new Error(
      "backup sweep returned non-JSON (is dotflowy running? restart after deploy)",
    );
  }
  const body = (await res.json()) as {
    exported?: { doName: string; nodes: number; kv: number }[];
  };
  const exported = body.exported ?? [];
  for (const row of exported) {
    log(`sweep exported do=${row.doName} nodes=${row.nodes} kv=${row.kv}`);
  }
  return exported;
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

async function wranglerR2Get(
  bucket: string,
  key: string,
  opts: Pick<CliOptions, "persistTo" | "r2Mode">,
): Promise<Uint8Array | null> {
  const args = [
    "wrangler",
    "r2",
    "object",
    "get",
    `${bucket}/${key}`,
    "--pipe",
  ];
  if (opts.r2Mode === "local") {
    args.push("--local", "--persist-to", opts.persistTo);
  } else {
    args.push("--remote");
  }

  const proc = Bun.spawn(["bunx", ...args], {
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).arrayBuffer(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code === 0) return new Uint8Array(stdout);
  if (/not found|does not exist|404/i.test(stderr)) return null;
  throw new Error(
    `wrangler r2 get ${bucket}/${key} failed (${code}): ${stderr.trim()}`,
  );
}

async function fetchSnapshot(
  opts: CliOptions,
): Promise<ReturnType<typeof decodeSnapshot>> {
  const key = snapshotR2Key(opts.doName, opts.date);
  log(
    `reading operator snapshot s3://${BACKUPS_BUCKET}/${key} (${opts.r2Mode})`,
  );
  const bytes = await wranglerR2Get(BACKUPS_BUCKET, key, opts);
  if (!bytes) {
    throw new Error(
      `no operator snapshot at ${key}; run the sweep first or pass --skip-sweep after exporting`,
    );
  }
  const json = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  return decodeSnapshot(json);
}

async function fetchMediaBlobs(
  snapshot: ReturnType<typeof decodeSnapshot>,
  mediaUserId: string,
  opts: CliOptions,
): Promise<Record<string, ContentBackupBlob>> {
  const rows = mediaRowsFromSnapshotKv(snapshot.kv);
  const blobs: Record<string, ContentBackupBlob> = {};
  let missing = 0;

  for (const row of rows) {
    const key = mediaR2Key(mediaUserId, row.id);
    const bytes = await wranglerR2Get(MEDIA_BUCKET, key, opts);
    if (!bytes) {
      missing++;
      log(`warning: media object missing for ${row.id} (${key})`);
      continue;
    }
    blobs[row.id] = {
      contentType: row.contentType,
      base64: encodeBlobBase64(bytes),
    };
  }

  log(
    `embedded ${Object.keys(blobs).length}/${rows.length} image blobs` +
      (missing ? ` (${missing} missing in R2)` : ""),
  );
  return blobs;
}

function applyRetention(opts: CliOptions): void {
  let names: string[];
  try {
    names = readdirSync(opts.archiveDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }

  const toDelete = backupDatesToDelete(names, opts.retention);
  if (!toDelete.length) {
    log(`retention: keeping all ${opts.retention} most recent date(s)`);
    return;
  }

  for (const date of toDelete) {
    for (const name of archiveFilenamesForDate(names, date)) {
      const path = resolve(opts.archiveDir, name);
      if (opts.dryRun) {
        log(`retention (dry-run): would delete ${path}`);
        continue;
      }
      unlinkSync(path);
      log(`retention: deleted ${path}`);
    }
  }
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  let doName = opts.doName;
  const ownerUserId = opts.mediaUserId ?? ownerUserIdFromDevVars();
  let mediaUserId = resolveMediaUserId(doName, ownerUserId);

  log(
    `date=${opts.date} do=${doName} mediaUser=${mediaUserId} ` +
      `archive=${opts.archiveDir} mode=${opts.r2Mode}` +
      (opts.dryRun ? " (dry-run)" : ""),
  );

  if (!opts.skipSweep) {
    let exported: { doName: string; nodes: number; kv: number }[] = [];
    try {
      exported = await triggerBackupSweep(
        opts.workerUrl,
        process.env.AAFLOWY_SWEEP_SECRET ?? archiveSweepSecretFromDevVars(),
      );
    } catch (err) {
      log(
        `warning: could not trigger sweep (${err instanceof Error ? err.message : err}); ` +
          "continuing with the latest existing R2 snapshot",
      );
    }
    if (exported.length) {
      doName = resolveArchiveDoName(exported, doName);
      mediaUserId = resolveMediaUserId(doName, ownerUserId);
      log(`archiving DO ${doName}`);
    }
  }

  const snapshot = await fetchSnapshot({ ...opts, doName });
  if (snapshot.nodes.length === 0) {
    throw new Error("refusing to archive an empty outline snapshot");
  }

  const blobs = await fetchMediaBlobs(snapshot, mediaUserId, {
    ...opts,
    doName,
  });
  const backup = snapshotToContentBackup(snapshot, blobs);
  const compressed = gzipSync(Buffer.from(JSON.stringify(backup)));
  const outName = backupFilename(Date.parse(`${opts.date}T12:00:00Z`));
  const outPath = resolve(opts.archiveDir, outName);

  if (opts.dryRun) {
    log(
      `dry-run: would write ${outPath} (${compressed.byteLength} bytes gzip)`,
    );
  } else {
    mkdirSync(opts.archiveDir, { recursive: true });
    writeFileSync(outPath, compressed);
    log(`wrote ${outPath} (${compressed.byteLength} bytes gzip)`);
  }

  applyRetention(opts);
}

main().catch((err) => {
  console.error(
    `[archive-backup] error: ${err instanceof Error ? err.message : err}`,
  );
  process.exit(1);
});
