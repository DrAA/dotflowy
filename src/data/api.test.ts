import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { ChangeOp } from "./realtime";

import {
  persistBatch,
  prepareStructuralWrite,
  resetApiCoordinatorsForTests,
  updateNodes,
} from "./api";

// Pins the structural-batch serialization (the `writeSem` semaphore in api.ts):
// rapid batches must NOT overlap on the wire (else the DO can reorder them and
// re-tear a sibling chain — ADR 0009), and a failed batch must not wedge the
// queue. A controllable fetch parks each request until the test resolves it, so
// we observe send order directly (the unit twin of the e2e `postDelayMs` seam).

const realFetch = globalThis.fetch;

interface Pending {
  body: string;
  resolve: (r: Response) => void;
}
let pending: Pending[] = [];

function installControlledFetch(): void {
  pending = [];
  globalThis.fetch = ((_url: string, init: { body?: unknown }) =>
    new Promise<Response>((resolve) => {
      pending.push({ body: String(init.body), resolve });
    })) as unknown as typeof fetch;
}

/** A pending request, narrowed away from undefined (noUncheckedIndexedAccess). */
function at(i: number): Pending {
  const p = pending[i];
  if (!p) throw new Error(`expected a pending request at index ${i}`);
  return p;
}

/** Let parked fibers advance (semaphore acquire → fetch fire) on a real tick. */
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 10));

/** Wait until at least `n` controlled fetches are parked (suite-load resilient). */
async function waitPending(n: number, ms = 500): Promise<void> {
  const start = Date.now();
  while (pending.length < n) {
    if (Date.now() - start > ms) return;
    await new Promise((r) => setTimeout(r, 1));
  }
}

const ok = (seq: number): Response =>
  new Response(JSON.stringify({ seq }), { status: 200 });
const op = (key: string): ChangeOp => ({ op: "delete", key });

beforeEach(() => {
  resetApiCoordinatorsForTests();
  installControlledFetch();
});

afterEach(async () => {
  // Unblock any fiber still parked on fetch so its semaphore release can run,
  // then mint fresh coordinators for the next case.
  for (const p of pending) p.resolve(new Response(null, { status: 200 }));
  pending = [];
  await tick();
  resetApiCoordinatorsForTests();
  globalThis.fetch = realFetch;
});

describe("persistBatch serialization (writeSem)", () => {
  test("a second batch stays off the wire until the first responds", async () => {
    const p1 = persistBatch([op("a")]);
    const p2 = persistBatch([op("b")]);
    await waitPending(1);

    // Only batch A is in flight; B is parked on the semaphore.
    expect(pending.length).toBe(1);
    expect(at(0).body).toContain('"a"');

    at(0).resolve(ok(1));
    await waitPending(2);

    // A's response lands → B's request now leaves the client, in order.
    expect(pending.length).toBe(2);
    expect(at(1).body).toContain('"b"');

    at(1).resolve(ok(2));
    expect(await p1).toEqual({ seq: 1 });
    expect(await p2).toEqual({ seq: 2 });
  });

  test("a failed batch rejects its caller but does not wedge the next", async () => {
    const p1 = persistBatch([op("a")]);
    const p2 = persistBatch([op("b")]);
    await waitPending(1);
    expect(pending.length).toBe(1);

    // A 5xx is a received response (not a transport drop), so it never retries.
    at(0).resolve(new Response("boom", { status: 500 }));
    await expect(p1).rejects.toThrow();
    await waitPending(2);

    // The permit released on failure → B proceeded.
    expect(pending.length).toBe(2);
    at(1).resolve(ok(2));
    expect(await p2).toEqual({ seq: 2 });
  });
});

// Pins the field coalescer (the `fieldSem` generations in api.ts): rapid field
// edits serialize + coalesce into one PATCH per round trip, and -- the ADR 0010
// invariant -- every caller that merged into a failed generation rolls back
// together (shared-fate). A field PATCH is `void`-shaped (no `{seq}` body to
// read), so a 200 with any body is success and a 5xx rejects without retrying.
// (5xx is retriable in production via enqueueWrite, which resolves the caller.)
const okField = (): Response => new Response(null, { status: 200 });

describe("updateNodes field coalescer (fieldSem generations)", () => {
  test("shared-fate: both callers of a queued generation resolve together", async () => {
    // Gen 1 = A, sent alone (nothing in flight when it arms).
    const pA = updateNodes([{ id: "a", changes: { text: "a" } }]);
    await waitPending(1);
    expect(pending.length).toBe(1);

    // B and C land while gen 1 is in flight -> they share ONE generation.
    const pB = updateNodes([{ id: "b", changes: { text: "b" } }]);
    const pC = updateNodes([{ id: "c", changes: { text: "c" } }]);

    at(0).resolve(okField()); // gen 1 ok -> releases the permit
    await waitPending(2);
    expect(pending.length).toBe(2); // gen 2 (B+C merged) now in flight
    expect(at(1).body).toContain('"b"');
    expect(at(1).body).toContain('"c"');

    at(1).resolve(new Response("boom", { status: 500 })); // gen 2 queued
    await expect(pB).resolves.toBeUndefined();
    await expect(pC).resolves.toBeUndefined(); // shared-fate: C queues too
    await expect(pA).resolves.toBeUndefined();
  });

  test("coalesces a burst during the in-flight window into one PATCH", async () => {
    const pA = updateNodes([{ id: "a", changes: { text: "a1" } }]);
    await waitPending(1);
    expect(pending.length).toBe(1);
    expect(at(0).body).toContain("a1");

    // Burst while gen 1 is in flight: same id twice + a different id.
    updateNodes([{ id: "a", changes: { text: "a2" } }]);
    updateNodes([{ id: "a", changes: { text: "a3" } }]);
    updateNodes([{ id: "b", changes: { text: "b1" } }]);

    at(0).resolve(okField());
    await waitPending(2);
    // One PATCH for the whole burst; last-write-wins on `a`, `b` carried along.
    expect(pending.length).toBe(2);
    const body = at(1).body;
    expect(body).toContain("a3");
    expect(body).not.toContain("a2"); // superseded by a3
    expect(body).toContain("b1");

    at(1).resolve(okField());
    await expect(pA).resolves.toBeUndefined();
  });

  test("a generation does not send before the prior responds", async () => {
    const pA = updateNodes([{ id: "a", changes: { text: "a" } }]);
    await waitPending(1);
    updateNodes([{ id: "b", changes: { text: "b" } }]); // gen 2, parked on permit
    await tick();
    expect(pending.length).toBe(1); // gen 2 stays off the wire

    at(0).resolve(okField());
    await waitPending(2);
    expect(pending.length).toBe(2);
    expect(at(1).body).toContain('"b"');
    at(1).resolve(okField());
    await pA;
  });

  test("a queued generation does not wedge the next", async () => {
    const pA = updateNodes([{ id: "a", changes: { text: "a" } }]);
    await waitPending(1);
    const pB = updateNodes([{ id: "b", changes: { text: "b" } }]); // gen 2

    at(0).resolve(new Response("boom", { status: 500 })); // gen 1 queued
    await expect(pA).resolves.toBeUndefined();
    await waitPending(2);
    expect(pending.length).toBe(2); // permit released -> gen 2 proceeded

    at(1).resolve(okField());
    await expect(pB).resolves.toBeUndefined();
  });

  test("merges field-wise last-write-wins per id", async () => {
    const pA = updateNodes([{ id: "a", changes: { text: "x" } }]);
    await waitPending(1);
    // During flight: overlapping + new fields on the same id.
    updateNodes([{ id: "a", changes: { completed: true } }]);
    updateNodes([{ id: "a", changes: { text: "y" } }]);

    at(0).resolve(okField());
    await waitPending(2);
    const body = at(1).body; // merged: { text: 'y', completed: true }
    expect(body).toContain('"y"');
    expect(body).toContain("completed");
    expect(body).not.toContain('"x"'); // text superseded
    at(1).resolve(okField());
    await pA;
  });

  test("the first edit hits the wire on a tick, not after a debounce", async () => {
    const pA = updateNodes([{ id: "a", changes: { text: "a" } }]);
    await waitPending(1); // one scheduler tick, not a timer window
    expect(pending.length).toBe(1);
    at(0).resolve(okField());
    await pA;
  });
});

describe("prepareStructuralWrite (undo vs field PATCH)", () => {
  test("discards a parked generation so it never hits the wire", async () => {
    const pA = updateNodes([{ id: "a", changes: { text: "a" } }]);
    await waitPending(1);
    // Gen 2 parks on the permit while gen 1 is in flight.
    const pB = updateNodes([{ id: "b", changes: { text: "typed" } }]);
    await tick();
    expect(pending.length).toBe(1);

    const drained = prepareStructuralWrite();
    at(0).resolve(okField());
    await drained;
    await tick();
    // Gen 2 must not send — epoch/pending were cleared before the permit freed.
    expect(pending.length).toBe(1);
    await expect(pA).resolves.toBeUndefined();
    await expect(pB).resolves.toBeUndefined();
  });

  test("waits for an in-flight PATCH even when currentGen is already null", async () => {
    const pA = updateNodes([{ id: "a", changes: { text: "typed" } }]);
    await waitPending(1);
    expect(pending.length).toBe(1);

    // Detach: no open generation, but the permit is still held by gen 1.
    let drained = false;
    const drain = prepareStructuralWrite().then(() => {
      drained = true;
    });
    await tick();
    expect(drained).toBe(false);

    at(0).resolve(okField());
    await drain;
    expect(drained).toBe(true);
    await expect(pA).resolves.toBeUndefined();
  });
});
