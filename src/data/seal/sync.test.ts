import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { Node } from "../schema";

import { createSeal } from "./keybag";
import { clearSealSession, setSealDek } from "./session";
import {
  configureSealPersistForTests,
  flushPersistSealedNodes,
  queuePersistSealedNodes,
  resetSealPersistForTests,
  schedulePersistSealedNodes,
} from "./sync";

function node(id: string, text: string): Node {
  return {
    id,
    parentId: null,
    prevSiblingId: null,
    text,
    isTask: false,
    completed: false,
    collapsed: false,
    createdAt: 1,
    updatedAt: 1,
  } as Node;
}

describe("sealed persist coalesce", () => {
  const calls: Array<{ path: string; method: string; bodySize: number }> = [];
  let originalFetch: typeof fetch;

  beforeEach(async () => {
    await resetSealPersistForTests();
    configureSealPersistForTests({
      fieldDebounceMs: 40,
      idleRevisionMs: 80,
    });
    calls.length = 0;
    const { dek } = await createSeal("seal persist test passphrase");
    setSealDek(dek);
    originalFetch = globalThis.fetch;
    globalThis.fetch = mock(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const path = url.startsWith("http")
          ? new URL(url).pathname
          : url.split("?")[0]!;
        const bodySize = typeof init?.body === "string" ? init.body.length : 0;
        calls.push({
          path,
          method: (init?.method ?? "GET").toUpperCase(),
          bodySize,
        });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    ) as typeof fetch;
  });

  afterEach(async () => {
    await resetSealPersistForTests();
    clearSealSession();
    globalThis.fetch = originalFetch;
  });

  test("field schedule writes snapshot only, not a revision", async () => {
    schedulePersistSealedNodes([node("a", "one")]);
    await Bun.sleep(70);
    // Let the encrypt+PUT settle.
    await Bun.sleep(30);
    const snapshots = calls.filter(
      (c) => c.path === "/api/seal/snapshot" && c.method === "PUT",
    );
    const revisions = calls.filter(
      (c) => c.path === "/api/seal/revisions" && c.method === "POST",
    );
    expect(snapshots.length).toBe(1);
    expect(revisions.length).toBe(0);
  });

  test("coalesces burst of field schedules into one snapshot", async () => {
    schedulePersistSealedNodes([node("a", "1")]);
    schedulePersistSealedNodes([node("a", "12")]);
    schedulePersistSealedNodes([node("a", "123")]);
    await Bun.sleep(70);
    await Bun.sleep(30);
    const snapshots = calls.filter(
      (c) => c.path === "/api/seal/snapshot" && c.method === "PUT",
    );
    expect(snapshots.length).toBe(1);
  });

  test("flush writes snapshot and revision immediately", async () => {
    await flushPersistSealedNodes([node("a", "done")]);
    const snapshots = calls.filter(
      (c) => c.path === "/api/seal/snapshot" && c.method === "PUT",
    );
    const revisions = calls.filter(
      (c) => c.path === "/api/seal/revisions" && c.method === "POST",
    );
    expect(snapshots.length).toBe(1);
    expect(revisions.length).toBe(1);
  });

  test("idle quiet after field persist appends one revision", async () => {
    schedulePersistSealedNodes([node("a", "idle")]);
    await Bun.sleep(70);
    await Bun.sleep(30);
    const afterField = calls.filter(
      (c) => c.path === "/api/seal/revisions" && c.method === "POST",
    ).length;
    expect(afterField).toBe(0);
    await Bun.sleep(100);
    await Bun.sleep(30);
    const revisions = calls.filter(
      (c) => c.path === "/api/seal/revisions" && c.method === "POST",
    );
    expect(revisions.length).toBe(1);
  });

  test("serialize overlapping flushes (no concurrent uploads)", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    globalThis.fetch = mock(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const path = url.startsWith("http")
          ? new URL(url).pathname
          : url.split("?")[0]!;
        const bodySize = typeof init?.body === "string" ? init.body.length : 0;
        calls.push({
          path,
          method: (init?.method ?? "GET").toUpperCase(),
          bodySize,
        });
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await Bun.sleep(25);
        inFlight--;
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    ) as typeof fetch;

    const a = flushPersistSealedNodes([node("a", "first")]);
    const b = flushPersistSealedNodes([node("a", "second")]);
    await Promise.all([a, b]);
    expect(maxInFlight).toBe(1);
    const snapshots = calls.filter(
      (c) => c.path === "/api/seal/snapshot" && c.method === "PUT",
    );
    const revisions = calls.filter(
      (c) => c.path === "/api/seal/revisions" && c.method === "POST",
    );
    // Second flush supersedes the first during encrypt — one snapshot+revision.
    expect(snapshots.length).toBe(1);
    expect(revisions.length).toBe(1);
  });

  test("second revision uploads a delta much smaller than the snapshot", async () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      node(`n${i}`, `bullet text number ${i} with some padding`),
    );
    await flushPersistSealedNodes(many);
    const afterFirst = calls.filter(
      (c) => c.path === "/api/seal/revisions" && c.method === "POST",
    );
    expect(afterFirst.length).toBe(1);
    const firstRevSize = afterFirst[0]!.bodySize;

    calls.length = 0;
    const next = many.map((n, i) =>
      i === 0 ? { ...n, text: "CHANGED", updatedAt: 2 } : n,
    );
    await flushPersistSealedNodes(next);
    const snapshots = calls.filter(
      (c) => c.path === "/api/seal/snapshot" && c.method === "PUT",
    );
    const revisions = calls.filter(
      (c) => c.path === "/api/seal/revisions" && c.method === "POST",
    );
    expect(snapshots.length).toBe(1);
    expect(revisions.length).toBe(1);
    expect(revisions[0]!.bodySize).toBeLessThan(snapshots[0]!.bodySize / 4);
    expect(revisions[0]!.bodySize).toBeLessThan(firstRevSize / 4);
  });

  test("skips revision when outline matches baseline", async () => {
    const rows = [node("a", "same")];
    await flushPersistSealedNodes(rows);
    calls.length = 0;
    await flushPersistSealedNodes(rows);
    const snapshots = calls.filter(
      (c) => c.path === "/api/seal/snapshot" && c.method === "PUT",
    );
    const revisions = calls.filter(
      (c) => c.path === "/api/seal/revisions" && c.method === "POST",
    );
    expect(snapshots.length).toBe(1);
    expect(revisions.length).toBe(0);
  });

  test("queuePersist returns before the upload runs", async () => {
    queuePersistSealedNodes([node("a", "queued")], { revision: true });
    expect(calls.filter((c) => c.path === "/api/seal/snapshot").length).toBe(0);
    await Bun.sleep(50);
    await Bun.sleep(30);
    expect(
      calls.filter((c) => c.path === "/api/seal/snapshot" && c.method === "PUT")
        .length,
    ).toBe(1);
  });
});
