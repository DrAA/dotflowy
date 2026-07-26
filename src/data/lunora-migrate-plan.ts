/**
 * Pure migrate planner (ADR 0058) — classic DO → Lunora heal decisions.
 * Unit-tested without a live store / network.
 */

export type MigrateStateSnapshot = {
  nodesAt: number | null;
  kvAt: number | null;
};

/** What the migrate runner should do next. */
export type MigrateStep =
  | "full"
  | "kv-only"
  | "mark-kv-complete"
  | "noop"
  | "empty-source";

export type PlanMigrateStepsInput = {
  lunoraNodeCount: number;
  migrateState: MigrateStateSnapshot | null;
  classicHasNodes: boolean;
  classicKvCount: number;
  lunoraKvCount: number;
};

/**
 * Decide migrate work from counts + watermarks.
 * Never skip solely because `lunoraNodeCount > 0` — KV may still be incomplete.
 */
export function planMigrateSteps(input: PlanMigrateStepsInput): MigrateStep {
  const nodesAt = input.migrateState?.nodesAt ?? null;
  const kvAt = input.migrateState?.kvAt ?? null;

  if (nodesAt != null && kvAt != null) return "noop";

  if (input.lunoraNodeCount === 0) {
    if (input.classicHasNodes) return "full";
    // No classic nodes — still heal orphan classic KV, else seed path.
    if (kvAt == null) {
      if (input.classicKvCount > 0) return "kv-only";
      if (input.lunoraKvCount > 0) return "mark-kv-complete";
    }
    return "empty-source";
  }

  // Lunora already has nodes — never treat that as migrate-complete alone.
  if (kvAt != null) return "noop";
  if (input.classicKvCount > 0) return "kv-only";
  // classicKvCount === 0 means a successful empty classic read (failed GETs
  // must reject before reaching the planner). Stamp kvAt when Lunora already
  // has side-collection rows, or when both sides are empty (nothing to
  // import) — otherwise we'd retry forever.
  return "mark-kv-complete";
}

export type ClassicKvRow = { key: string; value: unknown };

export type ImportKvRow =
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

/** Classic `/api/kv?collection=daily-index` value → Lunora `importKvRows` row. */
export function classicDailyRowToImport(
  row: ClassicKvRow,
  touchedAt: number,
): Extract<ImportKvRow, { kind: "dailyIndex" }> | null {
  const value = row.value as { key?: string; nodeId?: string };
  const key = String(value.key ?? row.key);
  const nodeId = String(value.nodeId ?? "");
  if (!key || !nodeId) return null;
  return { kind: "dailyIndex", key, nodeId, touchedAt };
}

/** Classic tag-colors row → import shape. */
export function classicTagColorRowToImport(
  row: ClassicKvRow,
): Extract<ImportKvRow, { kind: "tagColor" }> | null {
  const value = row.value as { tag?: string; color?: string };
  const tag = String(value.tag ?? row.key);
  const color = String(value.color ?? "");
  if (!tag || !color) return null;
  return { kind: "tagColor", tag, color };
}

/** Classic saved-queries row → import shape. */
export function classicSavedQueryRowToImport(
  row: ClassicKvRow,
  touchedAt: number,
): Extract<ImportKvRow, { kind: "savedQuery" }> | null {
  const value = row.value as {
    id?: string;
    name?: string;
    query?: string;
    createdAt?: number;
  };
  const id = String(value.id ?? row.key);
  if (!id) return null;
  return {
    kind: "savedQuery",
    id,
    name: String(value.name ?? value.query ?? id),
    query: String(value.query ?? ""),
    createdAt: Number(value.createdAt ?? touchedAt),
  };
}

/** Build the full importKvRows payload from classic side-collection fetches. */
export function planClassicKvImportRows(input: {
  tagColors: ClassicKvRow[];
  savedQueries: ClassicKvRow[];
  dailyIndex: ClassicKvRow[];
  touchedAt: number;
}): ImportKvRow[] {
  const { touchedAt } = input;
  return [
    ...input.tagColors.flatMap((row) => {
      const mapped = classicTagColorRowToImport(row);
      return mapped ? [mapped] : [];
    }),
    ...input.savedQueries.flatMap((row) => {
      const mapped = classicSavedQueryRowToImport(row, touchedAt);
      return mapped ? [mapped] : [];
    }),
    ...input.dailyIndex.flatMap((row) => {
      const mapped = classicDailyRowToImport(row, touchedAt);
      return mapped ? [mapped] : [];
    }),
  ];
}
