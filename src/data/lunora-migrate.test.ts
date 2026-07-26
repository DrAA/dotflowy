import { afterEach, describe, expect, test } from "bun:test";

import type { OutlineStore } from "./lunora-outline-store";

import {
  fetchClassicKvBundles,
  migrateClassicToLunora,
} from "./lunora-migrate";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

function jsonOk(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

function installKvFetch(
  handlers: Record<string, () => Response | Promise<Response>>,
): void {
  globalThis.fetch = ((url: string) => {
    const u = String(url);
    const collection = new URL(u, "http://local").searchParams.get(
      "collection",
    );
    if (!collection || !(collection in handlers)) {
      return Promise.reject(new Error(`unexpected fetch ${u}`));
    }
    return Promise.resolve(handlers[collection]!());
  }) as unknown as typeof fetch;
}

function readyCollection(rows: unknown[]) {
  return {
    toArray: rows,
    toArrayWhenReady: () => Promise.resolve(rows),
  };
}

/** Minimal store stub for migrateClassicToLunora unit tests. */
function stubStore(opts: {
  nodes?: unknown[];
  tagColors?: unknown[];
  savedQueries?: unknown[];
  dailyIndex?: unknown[];
  migrateState?: { nodesAt: number | null; kvAt: number | null } | null;
}): OutlineStore {
  const migrateState = opts.migrateState ?? null;
  return {
    client: {
      callMutator: async (ref: string) => {
        if (ref === "mutators:getMigrateState") {
          return { result: migrateState };
        }
        if (ref === "mutators:setMigrateState") {
          return { result: null };
        }
        throw new Error(`unexpected mutator ${ref}`);
      },
      importRows: async () => ({ imported: 0 }),
    },
    collection: readyCollection(opts.nodes ?? [{ id: "n1" }]),
    tagColors: readyCollection(opts.tagColors ?? []),
    savedQueries: readyCollection(opts.savedQueries ?? []),
    dailyIndex: readyCollection(opts.dailyIndex ?? []),
    mutators: {},
  } as unknown as OutlineStore;
}

describe("fetchClassicKvBundles", () => {
  test("count 0 only when every GET succeeds with []", async () => {
    installKvFetch({
      "tag-colors": () => jsonOk([]),
      "saved-queries": () => jsonOk([]),
      "daily-index": () => jsonOk([]),
    });
    const bundles = await fetchClassicKvBundles();
    expect(bundles.count).toBe(0);
    expect(bundles.tagColors).toEqual([]);
    expect(bundles.savedQueries).toEqual([]);
    expect(bundles.dailyIndex).toEqual([]);
  });

  test("rejects when any /api/kv GET fails (never treats failure as empty)", async () => {
    installKvFetch({
      "tag-colors": () => jsonOk([]),
      "saved-queries": () =>
        new Response("boom", { status: 500, statusText: "Internal" }),
      "daily-index": () => jsonOk([{ key: "container", nodeId: "d" }]),
    });
    await expect(fetchClassicKvBundles()).rejects.toThrow(
      /GET \/api\/kv saved-queries 500/,
    );
  });

  test("rejects on network failure for a collection", async () => {
    installKvFetch({
      "tag-colors": () => {
        throw new Error("network down");
      },
      "saved-queries": () => jsonOk([]),
      "daily-index": () => jsonOk([]),
    });
    await expect(fetchClassicKvBundles()).rejects.toThrow("network down");
  });
});

describe("migrateClassicToLunora", () => {
  test("both watermarks set → skipped-complete without classic fetch", async () => {
    let fetchCalls = 0;
    globalThis.fetch = (() => {
      fetchCalls += 1;
      return Promise.reject(new Error("classic fetch must not run"));
    }) as unknown as typeof fetch;

    const result = await migrateClassicToLunora(
      stubStore({
        nodes: [{ id: "a" }, { id: "b" }],
        migrateState: { nodesAt: 100, kvAt: 200 },
      }),
      "user-1",
    );

    expect(result).toEqual({ status: "skipped-complete", nodes: 2 });
    expect(fetchCalls).toBe(0);
  });
});
