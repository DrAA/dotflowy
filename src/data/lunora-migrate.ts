/**
 * One-shot UserOutlineDO → Lunora shard migrate (ADR 0058).
 *
 * Completeness is tracked in Lunora `migrateState` (`nodesAt` / `kvAt`).
 * `nodesAt` is stamped only after the classic node snapshot is fully
 * imported (missing-id chunks when Lunora already has a partial set).
 * Nodes alone never skip KV — a partial migrate (nodes landed, daily-index
 * missing) heals on the next flag-ON / `__dotflowyMigrateToLunora` pass.
 *
 * Auto-runs from `lunora-sync` when flag ON.
 * Manual: `await window.__dotflowyMigrateToLunora()`.
 */

import type { FunctionReference } from "lunorash/client";

import type { OutlineStore } from "./lunora-outline-store";

import { api } from "../../lunora/_generated/api";
import {
  planClassicKvImportRows,
  planMigrateSteps,
  type ClassicKvRow,
  type ImportKvRow,
  type MigrateStateSnapshot,
} from "./lunora-migrate-plan";
import { rowToNode, type OutlineNode } from "./outline-plans";
import { notifySaveFailed } from "./save-failure";

export type MigrateResult =
  | { status: "migrated"; nodes: number; kv: number }
  | { status: "skipped-complete"; nodes: number }
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

type ImportNodesArgs = { userId: string; nodes: ReadonlyArray<OutlineNode> };
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

async function fetchKv(collection: string): Promise<ClassicKvRow[]> {
  const res = await fetch(
    `/api/kv?collection=${encodeURIComponent(collection)}`,
    { credentials: "include" },
  );
  if (!res.ok) throw new Error(`GET /api/kv ${collection} ${res.status}`);
  const body = (await res.json()) as unknown;
  if (!Array.isArray(body)) {
    throw new Error(`GET /api/kv ${collection} returned a non-array body`);
  }
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

async function readMigrateState(
  store: OutlineStore,
  userId: string,
): Promise<MigrateStateSnapshot> {
  const { result } = await store.client.callMutator(
    "mutators:getMigrateState",
    { userId },
    { shardKey: userId },
  );
  const row = result as MigrateStateSnapshot | null | undefined;
  return {
    nodesAt: typeof row?.nodesAt === "number" ? row.nodesAt : null,
    kvAt: typeof row?.kvAt === "number" ? row.kvAt : null,
  };
}

async function writeMigrateState(
  store: OutlineStore,
  userId: string,
  patch: { nodesAt?: number | null; kvAt?: number | null },
): Promise<void> {
  await store.client.callMutator(
    "mutators:setMigrateState",
    { userId, ...patch },
    { shardKey: userId },
  );
}

async function importNodes(
  store: OutlineStore,
  userId: string,
  nodes: OutlineNode[],
): Promise<void> {
  if (nodes.length === 0) return;
  await store.client.importRows(migrationApi.mutators.importNodes, nodes, {
    importId: `classic-${userId}-nodes`,
    shardKey: userId,
    toArgs: (chunk) => ({ userId, nodes: chunk }),
  });
}

/**
 * Fetch classic DO side-collections. Empty arrays are only valid when GET
 * succeeds with `[]` — a failed fetch must reject so migrate leaves `kvAt`
 * null and can heal on retry (never stamp mark-kv-complete from a 5xx/network
 * miss).
 */
export async function fetchClassicKvBundles(): Promise<{
  tagColors: ClassicKvRow[];
  savedQueries: ClassicKvRow[];
  dailyIndex: ClassicKvRow[];
  count: number;
}> {
  const [tagColors, savedQueries, dailyIndex] = await Promise.all([
    fetchKv("tag-colors"),
    fetchKv("saved-queries"),
    fetchKv("daily-index"),
  ]);
  return {
    tagColors,
    savedQueries,
    dailyIndex,
    count: tagColors.length + savedQueries.length + dailyIndex.length,
  };
}

function lunoraKvCount(store: OutlineStore): number {
  return (
    store.tagColors.toArray.length +
    store.savedQueries.toArray.length +
    store.dailyIndex.toArray.length
  );
}

async function importKv(
  store: OutlineStore,
  userId: string,
  bundles: {
    tagColors: ClassicKvRow[];
    savedQueries: ClassicKvRow[];
    dailyIndex: ClassicKvRow[];
  },
): Promise<number> {
  const rows = planClassicKvImportRows({
    ...bundles,
    touchedAt: Date.now(),
  });
  if (rows.length === 0) return 0;
  const result = await store.client.importRows(
    migrationApi.mutators.importKvRows,
    rows,
    {
      importId: `classic-${userId}-kv`,
      shardKey: userId,
      toArgs: (chunk) => ({ userId, rows: chunk }),
    },
  );
  return result.imported;
}

/** Classic ids not yet on the Lunora shard — importNodes is insert-only. */
function missingClassicNodes(
  store: OutlineStore,
  classic: ClassicNode[],
  userId: string,
): OutlineNode[] {
  const existing = new Set(
    store.collection.toArray.map((n) => rowToNode(n).id),
  );
  return classic
    .filter((n) => !existing.has(n.id))
    .map((n) => asOutlineNode(n, userId));
}

/**
 * Import classic DO outline (+ kv) into Lunora, healing incomplete node/KV
 * halves independently. Classic DO data is left untouched. Existing Lunora
 * rows are preserved (missing-id node import; KV upsert).
 */
export async function migrateClassicToLunora(
  store: OutlineStore,
  userId: string,
): Promise<MigrateResult> {
  try {
    // Wait for side-collections so lunoraKvCount is accurate for mark-complete.
    await Promise.all([
      store.collection.toArrayWhenReady(),
      store.tagColors.toArrayWhenReady(),
      store.savedQueries.toArrayWhenReady(),
      store.dailyIndex.toArrayWhenReady(),
    ]);

    const migrateState = await readMigrateState(store, userId);
    const lunoraNodes = store.collection.toArray.length;

    // Both watermarks set → complete. Do not fetch classic: a 5xx/network
    // error would spuriously fail an already-finished migrate.
    if (migrateState.nodesAt != null && migrateState.kvAt != null) {
      return { status: "skipped-complete", nodes: lunoraNodes };
    }

    const classic = await fetchClassicNodes();
    const classicKv = await fetchClassicKvBundles();
    const step = planMigrateSteps({
      lunoraNodeCount: lunoraNodes,
      migrateState,
      classicHasNodes: classic.length > 0,
      classicKvCount: classicKv.count,
      lunoraKvCount: lunoraKvCount(store),
    });

    const now = Date.now();

    switch (step) {
      case "noop":
        return { status: "skipped-complete", nodes: lunoraNodes };
      case "empty-source":
        return { status: "skipped-empty-source" };
      case "mark-kv-complete": {
        // Stamp nodesAt only when classic has nothing left to import for
        // nodes — never invent completeness over a partial node import.
        const patch: { nodesAt?: number; kvAt?: number } = {};
        if (migrateState.nodesAt == null && classic.length === 0) {
          patch.nodesAt = now;
        }
        if (migrateState.kvAt == null) patch.kvAt = now;
        if (Object.keys(patch).length > 0) {
          await writeMigrateState(store, userId, patch);
        }
        return { status: "migrated", nodes: 0, kv: 0 };
      }
      case "kv-only": {
        const kv = await importKv(store, userId, classicKv);
        const patch: { nodesAt?: number; kvAt: number } = { kvAt: now };
        if (migrateState.nodesAt == null && classic.length === 0) {
          patch.nodesAt = now;
        }
        await writeMigrateState(store, userId, patch);
        return { status: "migrated", nodes: 0, kv };
      }
      case "full": {
        // importNodes is insert-only — skip ids already on the shard so a
        // partial prior import can top up without clobbering Lunora-era edits.
        const nodes = missingClassicNodes(store, classic, userId);
        await importNodes(store, userId, nodes);
        await writeMigrateState(store, userId, { nodesAt: now });
        let kv = 0;
        if (migrateState.kvAt == null) {
          kv = await importKv(store, userId, classicKv);
          await writeMigrateState(store, userId, { kvAt: Date.now() });
        }
        return { status: "migrated", nodes: nodes.length, kv };
      }
    }
  } catch (error) {
    return { status: "failed", error };
  }
}

/** Auto path: migrate / heal; returns whether seedIfEmpty should run. */
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
    case "skipped-complete":
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

/** DevTools entry. */
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
