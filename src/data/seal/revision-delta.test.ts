import { describe, expect, test } from "bun:test";

import type { Node } from "../schema";

import {
  buildSealRevisionDelta,
  nodesToBaselineMap,
  sealRevisionDeltaIsEmpty,
} from "./revision-delta";

function node(id: string, text: string, extra: Partial<Node> = {}): Node {
  return {
    id,
    parentId: null,
    prevSiblingId: null,
    text,
    isTask: false,
    completed: false,
    collapsed: false,
    bookmarkedAt: null,
    mirrorOf: null,
    createdAt: 1,
    updatedAt: 1,
    origin: null,
    kind: null,
    ...extra,
  } as Node;
}

describe("buildSealRevisionDelta", () => {
  test("null baseline upserts the full outline", () => {
    const nodes = [node("a", "one"), node("b", "two")];
    const delta = buildSealRevisionDelta(nodes, null);
    expect(delta.upserts.map((n) => n.id)).toEqual(["a", "b"]);
    expect(delta.deletes).toEqual([]);
  });

  test("emits only changed upserts and deletes", () => {
    const baseline = nodesToBaselineMap([
      node("a", "one"),
      node("b", "two"),
      node("c", "gone"),
    ]);
    const delta = buildSealRevisionDelta(
      [node("a", "ONE", { updatedAt: 2 }), node("b", "two")],
      baseline,
    );
    expect(delta.upserts.map((n) => n.id)).toEqual(["a"]);
    expect(delta.deletes).toEqual(["c"]);
    expect(sealRevisionDeltaIsEmpty(delta)).toBe(false);
  });

  test("empty when outline matches baseline", () => {
    const nodes = [node("a", "one")];
    const delta = buildSealRevisionDelta(nodes, nodesToBaselineMap(nodes));
    expect(sealRevisionDeltaIsEmpty(delta)).toBe(true);
  });
});
