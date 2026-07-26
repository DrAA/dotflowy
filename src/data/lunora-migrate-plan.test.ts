import { describe, expect, test } from "bun:test";

import {
  classicDailyRowToImport,
  planMigrateSteps,
} from "./lunora-migrate-plan";

describe("planMigrateSteps", () => {
  test("empty Lunora shard + classic nodes → full migrate", () => {
    expect(
      planMigrateSteps({
        lunoraNodeCount: 0,
        migrateState: null,
        classicHasNodes: true,
        classicKvCount: 2,
        lunoraKvCount: 0,
      }),
    ).toBe("full");
  });

  test("nodes present without kvAt → KV-only heal", () => {
    expect(
      planMigrateSteps({
        lunoraNodeCount: 10,
        migrateState: { nodesAt: 1, kvAt: null },
        classicHasNodes: true,
        classicKvCount: 3,
        lunoraKvCount: 0,
      }),
    ).toBe("kv-only");

    // Prod bootstrap: no migrateState row, nodes already on Lunora.
    expect(
      planMigrateSteps({
        lunoraNodeCount: 10,
        migrateState: null,
        classicHasNodes: false,
        classicKvCount: 3,
        lunoraKvCount: 0,
      }),
    ).toBe("kv-only");
  });

  test("both watermarks set → no-op", () => {
    expect(
      planMigrateSteps({
        lunoraNodeCount: 10,
        migrateState: { nodesAt: 1, kvAt: 2 },
        classicHasNodes: true,
        classicKvCount: 99,
        lunoraKvCount: 0,
      }),
    ).toBe("noop");
  });

  test("nodes present, classic KV empty, Lunora KV present → mark-kv-complete", () => {
    expect(
      planMigrateSteps({
        lunoraNodeCount: 5,
        migrateState: null,
        classicHasNodes: false,
        classicKvCount: 0,
        lunoraKvCount: 2,
      }),
    ).toBe("mark-kv-complete");
  });

  // Intentional: successful empty classic GET + empty Lunora KV = nothing to
  // import; stamp kvAt so heal doesn't retry forever (ADR 0058).
  test("nodes present, classic + Lunora KV both empty → mark-kv-complete", () => {
    expect(
      planMigrateSteps({
        lunoraNodeCount: 5,
        migrateState: { nodesAt: 1, kvAt: null },
        classicHasNodes: true,
        classicKvCount: 0,
        lunoraKvCount: 0,
      }),
    ).toBe("mark-kv-complete");
  });

  test("classic KV nonempty → kv-only (heal still imports)", () => {
    expect(
      planMigrateSteps({
        lunoraNodeCount: 8,
        migrateState: { nodesAt: 1, kvAt: null },
        classicHasNodes: true,
        classicKvCount: 4,
        lunoraKvCount: 0,
      }),
    ).toBe("kv-only");
  });

  test("empty everything → empty-source (seed path)", () => {
    expect(
      planMigrateSteps({
        lunoraNodeCount: 0,
        migrateState: null,
        classicHasNodes: false,
        classicKvCount: 0,
        lunoraKvCount: 0,
      }),
    ).toBe("empty-source");
  });
});

describe("classicDailyRowToImport", () => {
  test("classic /api/kv daily-index row → dailyIndex import shape", () => {
    expect(
      classicDailyRowToImport(
        {
          key: "2026-07-26",
          value: { key: "2026-07-26", nodeId: "day-node-1" },
        },
        1_700_000_000_000,
      ),
    ).toEqual({
      kind: "dailyIndex",
      key: "2026-07-26",
      nodeId: "day-node-1",
      touchedAt: 1_700_000_000_000,
    });
  });

  test("falls back to row.key when value.key missing", () => {
    expect(
      classicDailyRowToImport(
        { key: "container", value: { nodeId: "daily-root" } },
        42,
      ),
    ).toEqual({
      kind: "dailyIndex",
      key: "container",
      nodeId: "daily-root",
      touchedAt: 42,
    });
  });

  test("drops rows without nodeId", () => {
    expect(
      classicDailyRowToImport({ key: "x", value: { key: "x" } }, 1),
    ).toBeNull();
  });
});
