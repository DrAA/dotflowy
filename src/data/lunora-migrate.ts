/**
 * One-shot UserOutlineDO → Lunora shard migrate (ADR 0058).
 *
 * Safe default: if Lunora already has nodes, skip (do not replace).
 * Classic DO data is left untouched.
 *
 * Auto-runs from `lunora-sync` when flag ON + Lunora empty + classic has data.
 * Manual: `await window.__dotflowyMigrateToLunora()` or More menu.
 */

import type { FunctionReference } from "lunorash/client";

import type { OutlineStore } from "./lunora-outline-store";
import type { OutlineNode } from "./outline-plans";

import { api } from "../../lunora/_generated/api";
import { notifySaveFailed } from "./save-failure";

export type MigrateResult =
  | { status: "migrated"; nodes: number; kv: number }
  | { status: "skipped-nonempty"; nodes: number }
  | { status: "skipped-empty-source" }
  | { status: "failed"; error: unknown };

type ClassicNode = {
  id: string;
  parentId: string | null;
  prevSiblingId: string | null;
  text: string;
  isTask: boolean;
  completed: boolean;
  collapsed: boolean;
  bookmarkedAt: number | null;
  mirrorOf: string | null;
  createdAt: number;
  updatedAt: number;
  origin: string | null;
  kind: "paragraph" | null;
};

type KvRow = { key: string; value: unknown };

type ImportNodesArgs = { userId: string; nodes: ReadonlyArray<OutlineNode> };
type ImportKvRow =
  | { kind: "tagColor"; tag: string; color: string }
  | {
      kind: "savedQuery";
      id: string;
      name: string;
      query: string;
      createdAt: number;
    }
  | {
      kind: "dailyIndex";
      key: string;
      nodeId: string;
      touchedAt: number;
    };
type MigrationApi = {
  mutators: {
    importNodes: FunctionReference<"mutation", ImportNodesArgs, unknown>;
    importKvRows: FunctionReference<
      "mutation",
      { userId: string; rows: ReadonlyArray<ImportKvRow> },
      unknown
    >;
  };
};

const migrationApi = api as unknown as MigrationApi;

function asOutlineNode(n: ClassicNode, userId: string): OutlineNode {
  return {
    id: n.id,
    parentId: n.parentId,
    prevSiblingId: n.prevSiblingId,
    text: n.text,
    isTask: n.isTask,
    completed: n.completed,
    collapsed: n.collapsed,
    bookmarkedAt: n.bookmarkedAt,
    mirrorOf: n.mirrorOf,
    createdAt: n.createdAt,
    updatedAt: n.updatedAt,
    origin: n.origin,
    kind: n.kind === "paragraph" ? "paragraph" : null,
    userId,
  };
}

async function fetchClassicNodes(): Promise<ClassicNode[]> {
  const res = await fetch("/api/nodes", { credentials: "include" });
  if (!res.ok) throw new Error(`GET /api/nodes ${res.status}`);
  const body = (await res.json()) as ClassicNode[];
  return Array.isArray(body) ? body : [];
}

async function fetchKv(collection: string): Promise<KvRow[]> {
  const res = await fetch(
    `/api/kv?collection=${encodeURIComponent(collection)}`,
    { credentials: "include" },
  );
  if (!res.ok) throw new Error(`GET /api/kv ${collection} ${res.status}`);
  const body = (await res.json()) as unknown[];
  if (!Array.isArray(body)) return [];
  // /api/kv GET returns the stored values; daily-index/tag-colors/saved-queries
  // each embed their key inside the value object.
  return body.map((value) => {
    const v = value as Record<string, unknown>;
    const key =
      typeof v.key === "string"
        ? v.key
        : typeof v.tag === "string"
          ? v.tag
          : typeof v.id === "string"
            ? v.id
            : String(v.key ?? "");
    return { key, value };
  });
}

async function importNodes(
  store: OutlineStore,
  userId: string,
  nodes: OutlineNode[],
): Promise<void> {
  await store.client.importRows(migrationApi.mutators.importNodes, nodes, {
    importId: `classic-${userId}-nodes`,
    shardKey: userId,
    toArgs: (chunk) => ({ userId, nodes: chunk }),
  });
}

async function importKv(store: OutlineStore, userId: string): Promise<number> {
  const t = Date.now();

  const tags = await fetchKv("tag-colors").catch(() => [] as KvRow[]);
  const tagRows = tags.flatMap((row) => {
    const value = row.value as { tag?: string; color?: string };
    const tag = String(value.tag ?? row.key);
    const color = String(value.color ?? "");
    return tag && color ? [{ kind: "tagColor" as const, tag, color }] : [];
  });

  const saved = await fetchKv("saved-queries").catch(() => [] as KvRow[]);
  const savedRows = saved.flatMap((row) => {
    const value = row.value as {
      id?: string;
      name?: string;
      query?: string;
      createdAt?: number;
    };
    const id = String(value.id ?? row.key);
    return id
      ? [
          {
            kind: "savedQuery" as const,
            id,
            name: String(value.name ?? value.query ?? id),
            query: String(value.query ?? ""),
            createdAt: Number(value.createdAt ?? t),
          },
        ]
      : [];
  });

  const daily = await fetchKv("daily-index").catch(() => [] as KvRow[]);
  const dailyRows = daily.flatMap((row) => {
    const value = row.value as { key?: string; nodeId?: string };
    const key = String(value.key ?? row.key);
    const nodeId = String(value.nodeId ?? "");
    return key && nodeId
      ? [{ kind: "dailyIndex" as const, key, nodeId, touchedAt: t }]
      : [];
  });
  const result = await store.client.importRows(
    migrationApi.mutators.importKvRows,
    [...tagRows, ...savedRows, ...dailyRows],
    {
      importId: `classic-${userId}-kv`,
      shardKey: userId,
      toArgs: (rows) => ({ userId, rows }),
    },
  );

  return result.imported;
}

/**
 * Import classic DO outline (+ kv) into an empty Lunora shard.
 * @param force — unused for replace (replace is out of scope); reserved.
 */
export async function migrateClassicToLunora(
  store: OutlineStore,
  userId: string,
  opts: { force?: boolean } = {},
): Promise<MigrateResult> {
  void opts.force;
  const lunoraCount = store.collection.toArray.length;
  if (lunoraCount > 0) {
    return { status: "skipped-nonempty", nodes: lunoraCount };
  }

  try {
    const classic = await fetchClassicNodes();
    if (classic.length === 0) {
      return { status: "skipped-empty-source" };
    }
    const nodes = classic.map((n) => asOutlineNode(n, userId));
    await importNodes(store, userId, nodes);
    const kv = await importKv(store, userId);
    return { status: "migrated", nodes: nodes.length, kv };
  } catch (error) {
    return { status: "failed", error };
  }
}

/** Auto path: migrate when Lunora empty; returns whether seedIfEmpty should run. */
export async function maybeAutoMigrateToLunora(
  store: OutlineStore,
  userId: string,
): Promise<"seed" | "ready"> {
  const result = await migrateClassicToLunora(store, userId);
  switch (result.status) {
    case "migrated":
      console.info(
        `[lunora-migrate] imported ${result.nodes} nodes + ${result.kv} kv rows from classic DO`,
      );
      return "ready";
    case "skipped-nonempty":
      return "ready";
    case "skipped-empty-source":
      return "seed";
    case "failed":
      console.warn("[lunora-migrate] failed", result.error);
      notifySaveFailed(result.error);
      // Don't seed demo bullets over a failed migrate of real data — leave empty
      // so the operator can retry via __dotflowyMigrateToLunora.
      return "ready";
  }
}

/** DevTools / More-menu entry. */
export function installMigrateConsoleHelper(
  getStore: () => { store: OutlineStore; userId: string } | null,
): void {
  if (typeof window === "undefined") return;
  (
    window as unknown as {
      __dotflowyMigrateToLunora?: () => Promise<MigrateResult>;
    }
  ).__dotflowyMigrateToLunora = async () => {
    const ctx = getStore();
    if (!ctx) {
      return {
        status: "failed",
        error: new Error("Lunora sync not started (flag off?)"),
      };
    }
    return migrateClassicToLunora(ctx.store, ctx.userId);
  };
}
