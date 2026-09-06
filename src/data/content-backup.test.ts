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
  backupSubtreeIds,
  decodeBlobBase64,
  encodeBlobBase64,
  extractBackupSubtree,
  parseContentBackup,
  prepareSubtreeMerge,
  searchBackupNodes,
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

function node(
  id: string,
  parentId: string | null,
  prevSiblingId: string | null,
  text: string,
): Node {
  return {
    id,
    parentId,
    prevSiblingId,
    text,
    isTask: false,
    completed: false,
    collapsed: false,
    bookmarkedAt: null,
    mirrorOf: null,
    createdAt: 1,
    updatedAt: 1,
    origin: null,
    kind: null,
  };
}

describe("subtree extract + merge", () => {
  const backupNodes = [
    node("root", null, null, "Root"),
    node("keep", null, "root", "Keep me"),
    node("branch", null, "keep", "Branch"),
    node("child", "branch", null, "Child"),
    node("grand", "child", null, "Grand"),
  ];

  it("extracts a branch and its descendants", () => {
    const ids = backupSubtreeIds(backupNodes, "branch");
    expect([...ids].sort()).toEqual(["branch", "child", "grand"]);
    expect(
      extractBackupSubtree(backupNodes, "branch")
        .map((n) => n.id)
        .sort(),
    ).toEqual(["branch", "child", "grand"]);
  });

  it("merges a missing branch under the fallback parent", () => {
    const live = [
      node("root", null, null, "Root"),
      node("keep", null, "root", "Keep me"),
    ];
    const { targetNodes, restoredIds } = prepareSubtreeMerge(
      live,
      backupNodes,
      "branch",
      null,
    );
    expect([...restoredIds].sort()).toEqual(["branch", "child", "grand"]);
    const branch = targetNodes.find((n) => n.id === "branch")!;
    expect(branch.parentId).toBe(null);
    expect(branch.prevSiblingId).toBe("keep");
    expect(targetNodes.find((n) => n.id === "keep")?.text).toBe("Keep me");
    expect(targetNodes.find((n) => n.id === "grand")?.text).toBe("Grand");
  });

  it("replaces a live branch from the backup without touching siblings", () => {
    const live = [
      node("root", null, null, "Root"),
      node("keep", null, "root", "Keep me"),
      node("branch", null, "keep", "Stale branch"),
      node("stale-kid", "branch", null, "Should go"),
    ];
    const { targetNodes } = prepareSubtreeMerge(
      live,
      backupNodes,
      "branch",
      null,
    );
    expect(targetNodes.find((n) => n.id === "stale-kid")).toBeUndefined();
    expect(targetNodes.find((n) => n.id === "branch")?.text).toBe("Branch");
    expect(targetNodes.find((n) => n.id === "child")?.text).toBe("Child");
    expect(targetNodes.find((n) => n.id === "keep")?.text).toBe("Keep me");
  });

  it("searches backup bullets by plain text", () => {
    const hits = searchBackupNodes({ ...BACKUP, nodes: backupNodes }, "grand");
    expect(hits.map((n) => n.id)).toEqual(["grand"]);
  });
});
