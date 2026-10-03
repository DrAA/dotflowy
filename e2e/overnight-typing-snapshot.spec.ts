// Regression: after overnight idle / This week, a mid-session WS snapshot can
// truncate the collection while a bullet is focused. Typed characters that only
// lived in the contentEditable (PATCH ack already dropped the overlay) used to
// vanish a few seconds later when rows remounted onto server-old text.
import { expect, test, type Page } from "@playwright/test";

import {
  isE2eLunora,
  pushClassicSyncSnapshot,
  seedOutline,
  type SeedNode,
} from "./fixtures";

const text = (page: Page, id: string) =>
  page.locator(`li[data-node-id="${id}"] > .outline-row .node-text`);

const TREE: SeedNode[] = [
  { id: "n", parentId: null, prevSiblingId: null, text: "base" },
];

test.describe("overnight typing vs mid-session snapshot", () => {
  test.skip(isE2eLunora(), "classic /api/sync snapshot path only");

  test("focused typing survives a delayed snapshot with server-old text", async ({
    page,
  }) => {
    // Delay the field PATCH so the mock store (and thus the forced snapshot)
    // still carries "base" while the DOM already shows the typed suffix.
    await seedOutline(page, TREE, { patchDelayMs: 800 });
    await page.goto("/");
    await expect(text(page, "n")).toBeVisible({ timeout: 15_000 });

    await text(page, "n").click();
    await page.keyboard.type(" typed");
    await expect(text(page, "n")).toHaveText("base typed");

    // Mid-session resync (This week / reconnect past changelog window).
    pushClassicSyncSnapshot();

    // Hold past the PATCH delay + remount paint — characters must stick.
    await page.waitForTimeout(1200);
    await expect(text(page, "n")).toHaveText("base typed");
  });
});
