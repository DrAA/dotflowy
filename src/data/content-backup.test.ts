/**
 * Pure-logic tests for the user-facing content backup format
 * (src/data/content-backup.ts).
 */

import { describe, expect, it } from "bun:test";
import { Schema } from "effect";

import type { Node } from "./schema";

import {
  CONTENT_BACKUP_VERSION,
  ContentBackupSchema,
  backupFilename,
  decodeBlobBase64,
  encodeBlobBase64,
  parseContentBackup,
} from "./content-backup";

const decode = Schema.decodeUnknownSync(ContentBackupSchema);

const NODE: Node = {
  id: "a",
  parentId: null,
  prevSiblingId: null,
  text: "**Bold** bullet",
  isTask: true,
  completed: false,
  collapsed: false,
  bookmarkedAt: null,
  mirrorOf: null,
  createdAt: 1,
  updatedAt: 1,
  origin: null,
  kind: null,
};

const BACKUP = {
  version: CONTENT_BACKUP_VERSION,
  exportedAt: 1_700_000_000_000,
  app: "aaflowy" as const,
  nodes: [NODE],
  kv: [
    {
      collection: "media",
      key: "img-1",
      value: {
        id: "img-1",
        nodeId: "a",
        contentType: "image/png",
        bytes: 4,
        width: 10,
        height: 10,
        createdAt: 1,
      },
    },
    {
      collection: "tag-colors",
      key: "work",
      value: { tag: "work", color: "blue" },
    },
  ],
  blobs: {
    "img-1": { contentType: "image/png", base64: "iVBORw0KGgo=" },
  },
};

describe("ContentBackupSchema", () => {
  it("accepts a well-formed backup", () => {
    expect(() => decode(BACKUP)).not.toThrow();
    expect(parseContentBackup(BACKUP).nodes[0]!.text).toBe("**Bold** bullet");
  });

  it("rejects a backup with the wrong version", () => {
    expect(() => decode({ ...BACKUP, version: 99 })).toThrow();
  });

  it("rejects a node missing a required field", () => {
    const { kind: _kind, ...partial } = NODE;
    expect(() => decode({ ...BACKUP, nodes: [partial] })).toThrow();
  });

  it("rejects a backup without embedded blobs", () => {
    const { blobs: _b, ...rest } = BACKUP;
    expect(() => decode(rest)).toThrow();
  });
});

describe("blob base64 helpers", () => {
  it("round-trips bytes", () => {
    const bytes = new Uint8Array([0, 137, 255, 1]);
    expect(decodeBlobBase64(encodeBlobBase64(bytes))).toEqual(bytes);
  });
});

describe("backupFilename", () => {
  it("uses a dated gzip suffix", () => {
    const at = Date.parse("2026-07-17T12:00:00Z");
    expect(backupFilename(at)).toBe(
      "2026-07-17-aaflowy-backup.aaflowy-backup.json.gz",
    );
  });
});

describe("gzip round-trip", () => {
  it("preserves backup JSON through gzip", async () => {
    if (typeof CompressionStream === "undefined") return;
    const { gzipJson, gunzipJson } = await import("./content-backup");
    const compressed = await gzipJson(BACKUP);
    const parsed = await gunzipJson(compressed);
    expect(parseContentBackup(parsed)).toEqual(BACKUP);
  });
});
