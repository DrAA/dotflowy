import { describe, expect, test } from "bun:test";

import {
  listSealRevisionsAfter,
  sealRevKey,
  sealRevPrefix,
  sealSnapshotKey,
} from "./seal-r2";

describe("seal R2 keys", () => {
  test("snapshot and revision keys are user-scoped", () => {
    expect(sealSnapshotKey("u1")).toBe("seal/u1/snapshot");
    expect(sealRevPrefix("u1")).toBe("seal/u1/rev/");
    expect(sealRevKey("u1", 3)).toBe("seal/u1/rev/0000000000000003");
  });

  test("revision keys sort by seq", () => {
    const keys = [1, 10, 2].map((n) => sealRevKey("u", n));
    expect([...keys].sort()).toEqual([
      sealRevKey("u", 1),
      sealRevKey("u", 2),
      sealRevKey("u", 10),
    ]);
  });
});

describe("listSealRevisionsAfter", () => {
  test("returns envelopes with seq > after in order", async () => {
    const store = new Map<string, string>();
    for (const seq of [1, 2, 3]) {
      store.set(
        sealRevKey("u", seq),
        JSON.stringify({ v: seq, kind: "revision" }),
      );
    }
    const bucket = {
      async list(opts: { prefix: string }) {
        const objects = [...store.keys()]
          .filter((k) => k.startsWith(opts.prefix))
          .map((key) => ({ key }));
        return { objects, truncated: false };
      },
      async get(key: string) {
        const raw = store.get(key);
        if (!raw) return null;
        return { text: async () => raw };
      },
    };
    const items = await listSealRevisionsAfter(
      bucket as unknown as R2Bucket,
      "u",
      1,
    );
    expect(items.map((i) => i.seq)).toEqual([2, 3]);
    expect((items[0]!.envelope as { v: number }).v).toBe(2);
  });
});
