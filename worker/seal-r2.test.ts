import { describe, expect, test } from "bun:test";

import { sealRevKey, sealRevPrefix, sealSnapshotKey } from "./seal-r2";

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
