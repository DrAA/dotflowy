/**
 * Pure-logic tests for the daily archive backup helpers
 * (scripts/archive-backup-lib.ts).
 */

import { describe, expect, it } from "bun:test";

import type { OutlineSnapshot } from "../worker/backup";

import { SNAPSHOT_VERSION } from "../worker/backup";
import {
  backupDatesToDelete,
  backupFilename,
  encodeBlobBase64,
  mediaR2Key,
  mediaRowsFromSnapshotKv,
  resolveArchiveDoName,
  resolveMediaUserId,
  snapshotR2Key,
  snapshotToContentBackup,
  sortedBackupDates,
} from "./archive-backup-lib";

const SNAPSHOT: OutlineSnapshot = {
  version: SNAPSHOT_VERSION,
  exportedAt: 1_700_000_000_000,
  seq: 1,
  nodes: [
    {
      id: "a",
      parentId: null,
      prevSiblingId: null,
      text: "hello",
      isTask: false,
      completed: false,
      collapsed: false,
      bookmarkedAt: null,
      mirrorOf: null,
      createdAt: 1,
      updatedAt: 1,
      origin: null,
      kind: null,
    },
  ],
  kv: [
    {
      collection: "media",
      key: "img-1",
      value: JSON.stringify({
        id: "img-1",
        nodeId: "a",
        contentType: "image/png",
        bytes: 4,
        width: 1,
        height: 1,
        createdAt: 1,
      }),
      updatedAt: 1,
    },
    {
      collection: "tag-colors",
      key: "work",
      value: JSON.stringify({ tag: "work", color: "blue" }),
      updatedAt: 1,
    },
  ],
};

describe("backupFilename", () => {
  it("uses the dated gzip suffix", () => {
    const at = Date.parse("2026-07-17T12:00:00Z");
    expect(backupFilename(at)).toBe(
      "2026-07-17-aaflowy-backup.aaflowy-backup.json.gz",
    );
  });
});

describe("snapshot keys", () => {
  it("maps DO names and dates to operator R2 keys", () => {
    expect(snapshotR2Key("default", "2026-07-17")).toBe(
      "backups/default/2026-07-17.json",
    );
    expect(mediaR2Key("user_abc", "img-1")).toBe("media/user_abc/img-1");
  });
});

describe("resolveMediaUserId", () => {
  it("uses OWNER_USER_ID for the default DO", () => {
    expect(resolveMediaUserId("default", "owner-id")).toBe("owner-id");
  });

  it("passes through non-default DO names", () => {
    expect(resolveMediaUserId("user_abc", "owner-id")).toBe("user_abc");
  });
});

describe("snapshotToContentBackup", () => {
  it("parses kv JSON and attaches blobs", () => {
    const blobs = {
      "img-1": { contentType: "image/png", base64: "aGVsbG8=" },
    };
    const backup = snapshotToContentBackup(SNAPSHOT, blobs);
    expect(backup.app).toBe("aaflowy");
    expect(backup.kv[1]?.value).toEqual({ tag: "work", color: "blue" });
    expect(backup.blobs).toEqual(blobs);
  });
});

describe("mediaRowsFromSnapshotKv", () => {
  it("reads media metadata rows", () => {
    expect(mediaRowsFromSnapshotKv(SNAPSHOT.kv)).toEqual([
      {
        id: "img-1",
        nodeId: "a",
        contentType: "image/png",
      },
    ]);
  });
});

describe("encodeBlobBase64", () => {
  it("round-trips bytes", () => {
    const bytes = new Uint8Array([104, 101, 108, 108, 111]);
    expect(encodeBlobBase64(bytes)).toBe("aGVsbG8=");
  });
});

describe("resolveArchiveDoName", () => {
  const exported = [
    { doName: "default", nodes: 0 },
    { doName: "user_abc", nodes: 20119 },
  ];

  it("picks the DO with the most nodes", () => {
    expect(resolveArchiveDoName(exported, "default")).toBe("user_abc");
  });

  it("honors explicit name when tied for largest", () => {
    expect(
      resolveArchiveDoName(
        [
          { doName: "default", nodes: 5 },
          { doName: "user_abc", nodes: 5 },
        ],
        "default",
      ),
    ).toBe("default");
  });
});

describe("retention", () => {
  const files = [
    "2026-08-24-aaflowy-backup.aaflowy-backup.json.gz",
    "2026-08-25-aaflowy-backup.aaflowy-backup.json.gz",
    "2026-08-26-aaflowy-backup.aaflowy-backup.json.gz",
    "2026-08-27-aaflowy-backup.aaflowy-backup.json.gz",
    "README.txt",
  ];

  it("sorts unique dates newest first", () => {
    expect(sortedBackupDates(files)).toEqual([
      "2026-08-27",
      "2026-08-26",
      "2026-08-25",
      "2026-08-24",
    ]);
  });

  it("keeps the three most recent dates", () => {
    expect(backupDatesToDelete(files, 3)).toEqual(["2026-08-24"]);
  });
});
