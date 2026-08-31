import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { Node } from "./schema";

import {
  isRetriableNodesError,
  NodesLimitError,
  NodesResponseError,
  NodesTimeoutError,
  NodesTransportError,
} from "./nodes-client-effect";
import {
  clearWriteQueueMemoryForTests,
  enqueueWrite,
  getPendingWriteCount,
  reloadWriteQueueFromStorage,
  resetWriteQueueForTests,
  restoreQueuedSnapshotIfPresent,
} from "./write-queue";

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
  resetWriteQueueForTests();
});

afterEach(() => {
  resetWriteQueueForTests();
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

describe("isRetriableNodesError", () => {
  test("transport and timeout failures are retriable", () => {
    expect(
      isRetriableNodesError(new NodesTransportError({ cause: "offline" })),
    ).toBe(true);
    expect(isRetriableNodesError(new NodesTimeoutError())).toBe(true);
  });

  test("5xx and 429 are retriable", () => {
    expect(isRetriableNodesError(new NodesResponseError({ status: 500 }))).toBe(
      true,
    );
    expect(isRetriableNodesError(new NodesResponseError({ status: 429 }))).toBe(
      true,
    );
  });

  test("node limit and other 4xx are not retriable", () => {
    expect(isRetriableNodesError(new NodesLimitError({ limit: 100 }))).toBe(
      false,
    );
    expect(isRetriableNodesError(new NodesResponseError({ status: 403 }))).toBe(
      false,
    );
    expect(isRetriableNodesError(new NodesResponseError({ status: 400 }))).toBe(
      false,
    );
  });
});

describe("write-queue localStorage persistence", () => {
  test("enqueueWrite persists queue and snapshot to localStorage", () => {
    const snapshot = [node({ id: "a", text: "queued" })];
    enqueueWrite(
      { kind: "field", updates: [{ id: "a", changes: { text: "x" } }] },
      snapshot,
    );

    expect(getPendingWriteCount()).toBe(1);
    expect(store.has("dotflowy:write-queue")).toBe(true);
    expect(store.has("dotflowy:write-queue:nodes")).toBe(true);

    clearWriteQueueMemoryForTests();
    expect(getPendingWriteCount()).toBe(0);

    reloadWriteQueueFromStorage();
    expect(getPendingWriteCount()).toBe(1);
    expect(restoreQueuedSnapshotIfPresent()).toEqual(snapshot);
  });

  test("restoreQueuedSnapshotIfPresent returns null when queue is empty", () => {
    store.set(
      "dotflowy:write-queue:nodes",
      JSON.stringify([node({ id: "a" })]),
    );
    expect(restoreQueuedSnapshotIfPresent()).toBeNull();
    expect(store.has("dotflowy:write-queue:nodes")).toBe(false);
  });
});
