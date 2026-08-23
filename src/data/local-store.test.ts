import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { Node } from "./schema";

import {
  inferKvKey,
  readLocalKvRecord,
  readLocalNodes,
  writeLocalKvRecord,
  writeLocalNodes,
} from "./local-store";

const store = new Map<string, string>();

beforeEach(() => {
  store.clear();
  (globalThis as { window?: unknown }).window = {
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        store.set(k, v);
      },
      removeItem: (k: string) => {
        store.delete(k);
      },
    },
  };
});

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

function node(partial: Partial<Node> & { id: string }): Node {
  return {
    parentId: null,
    prevSiblingId: null,
    text: "",
    isTask: false,
    completed: false,
    collapsed: false,
    bookmarkedAt: null,
    mirrorOf: null,
    createdAt: 0,
    updatedAt: 0,
    origin: null,
    kind: null,
    ...partial,
  };
}

describe("local-store nodes", () => {
  test("round-trips an outline", () => {
    const rows = [node({ id: "a", text: "Hello" })];
    writeLocalNodes(rows);
    expect(readLocalNodes()).toEqual(rows);
  });

  test("missing key is an empty outline", () => {
    expect(readLocalNodes()).toEqual([]);
  });
});

describe("local-store kv", () => {
  test("round-trips a collection record", () => {
    writeLocalKvRecord("tag-colors", { work: { tag: "work", color: "blue" } });
    expect(readLocalKvRecord("tag-colors")).toEqual({
      work: { tag: "work", color: "blue" },
    });
  });

  test("inferKvKey prefers id, then tag, then key", () => {
    expect(inferKvKey({ id: "n1" }, "x")).toBe("n1");
    expect(inferKvKey({ tag: "work" }, "x")).toBe("work");
    expect(inferKvKey({ key: "container" }, "x")).toBe("container");
    expect(inferKvKey({}, "fallback")).toBe("fallback");
  });
});
