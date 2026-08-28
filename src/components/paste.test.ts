import { describe, expect, test } from "bun:test";

import { filesFromClipboard } from "./paste";

const png = new File([new Uint8Array([1, 2, 3])], "shot.png", {
  type: "image/png",
});

function fakeClipboard(opts: {
  files?: File[];
  items?: { kind: string; getAsFile: () => File | null }[];
}): DataTransfer {
  return {
    files: (opts.files ?? []) as unknown as FileList,
    items: (opts.items ?? []) as unknown as DataTransferItemList,
  } as DataTransfer;
}

describe("filesFromClipboard", () => {
  test("uses clipboardData.files when present", () => {
    expect(
      filesFromClipboard(
        fakeClipboard({
          files: [png],
          items: [{ kind: "file", getAsFile: () => png }],
        }),
      ),
    ).toEqual([png]);
  });

  test("falls back to items when files is empty", () => {
    expect(
      filesFromClipboard(
        fakeClipboard({
          files: [],
          items: [
            { kind: "string", getAsFile: () => null },
            { kind: "file", getAsFile: () => png },
          ],
        }),
      ),
    ).toEqual([png]);
  });

  test("returns nothing when neither files nor file items exist", () => {
    expect(filesFromClipboard(fakeClipboard({}))).toEqual([]);
  });
});
