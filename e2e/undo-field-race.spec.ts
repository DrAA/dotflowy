// Regression: typing's field PATCH (fieldSem) used to race undo's structural
// restore (writeSem). An in-flight or parked keystroke write could land on the
// DO *after* undo and bounce the undone text back. Classic path only —
// prepareStructuralWrite drains fieldSem before planning the restore.
import { expect, test, type Page } from "@playwright/test";

import { seedOutline, type SeedNode } from "./fixtures";

const text = (page: Page, id: string) =>
  page.locator(`li[data-node-id="${id}"] > .outline-row .node-text`);

const TREE: SeedNode[] = [
  { id: "n", parentId: null, prevSiblingId: null, text: "hello" },
];

test.describe("undo vs in-flight field PATCH", () => {
  test("undo sticks after a delayed keystroke PATCH lands", async ({
    page,
  }) => {
    await seedOutline(page, TREE, { patchDelayMs: 400 });
    await page.goto("/");
    await expect(text(page, "n")).toBeVisible({ timeout: 15_000 });

    await text(page, "n").click();
    await page.keyboard.type("X");
    await expect(text(page, "n")).toHaveText("helloX");

    // Undo while the PATCH is still delayed on the mock. Without draining
    // fieldSem first, the delayed apply would re-write "helloX" after restore.
    await page.keyboard.press("ControlOrMeta+z");
    await expect(text(page, "n")).toHaveText("hello");

    // Hold past the mock delay + a little slack so a bounce would show.
    await page.waitForTimeout(600);
    await expect(text(page, "n")).toHaveText("hello");
  });
});
