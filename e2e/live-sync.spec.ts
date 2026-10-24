// Another open page must see text and images without a reload.
import { expect, test, type Page } from "@playwright/test";

import { pushClassicSyncFrame, seedOutline } from "./fixtures";

const text = (page: Page, id: string) =>
  page.locator(`li[data-node-id="${id}"] > .outline-row .node-text`);

const row = (page: Page, id: string) =>
  page.locator(`li[data-node-id="${id}"]`);

test("remote text and image appear on an unfocused bullet", async ({
  page,
}) => {
  await seedOutline(page, [
    { id: "alpha", parentId: null, prevSiblingId: null, text: "Alpha" },
    { id: "bravo", parentId: null, prevSiblingId: "alpha", text: "Bravo" },
  ]);
  await page.goto("/");
  await expect(text(page, "bravo")).toHaveText("Bravo");
  // Leave Bravo unfocused — the bug skipped paint on exactly that row.
  await text(page, "alpha").click();

  await pushClassicSyncFrame({
    type: "change",
    seq: 1,
    ops: [
      {
        op: "update",
        value: {
          id: "bravo",
          parentId: null,
          prevSiblingId: "alpha",
          text: "from the other page",
          isTask: false,
          completed: false,
          collapsed: false,
          bookmarkedAt: null,
          mirrorOf: null,
          createdAt: 0,
          updatedAt: 0,
          origin: null,
          kind: null,
        },
      },
    ],
  });
  await expect(text(page, "bravo")).toHaveText("from the other page");

  await pushClassicSyncFrame({
    type: "media",
    upserts: [
      {
        id: "m-remote",
        nodeId: "bravo",
        contentType: "image/png",
        bytes: 8,
        width: 1,
        height: 1,
        createdAt: 1,
      },
    ],
    deletes: [],
  });
  await expect(row(page, "bravo").locator("img")).toHaveAttribute(
    "src",
    "/api/media/m-remote",
  );
});
