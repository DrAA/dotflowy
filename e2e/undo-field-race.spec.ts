// Regression: typing's field PATCH (fieldSem) used to race undo's structural
// restore (writeSem). An in-flight or parked keystroke write could land on the
// DO *after* undo and bounce the undone text back. Classic path only —
// prepareStructuralWrite drains fieldSem before planning the restore.
import { expect, test, type Page } from "@playwright/test";

import { isE2eLunora, seedOutline, type SeedNode } from "./fixtures";

const PNG_1x1_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const text = (page: Page, id: string) =>
  page.locator(`li[data-node-id="${id}"] > .outline-row .node-text`);

const TREE: SeedNode[] = [
  { id: "n", parentId: null, prevSiblingId: null, text: "hello" },
];

async function pastePng(page: Page, id: string) {
  await text(page, id).click();
  await text(page, id).evaluate((el, b64) => {
    const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const file = new File([bin], "dot.png", { type: "image/png" });
    const dt = new DataTransfer();
    dt.items.add(file);
    const event = new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData: dt,
    });
    Object.defineProperty(event, "clipboardData", { value: dt });
    el.dispatchEvent(event);
  }, PNG_1x1_B64);
}

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

// Regression: media restore used to run inside the nodes structural
// transaction. Media rows were mapped to ChangeOps → Worker 400 →
// "Couldn't save your changes" and the optimistic undo rolled back.
test.describe("undo with hosted image present", () => {
  test.skip(isE2eLunora(), "media mock rides classic /api/kv + /api/media");

  test("typing undo sticks and does not toast save failure", async ({
    page,
  }) => {
    await seedOutline(page, TREE);
    await page.goto("/");
    await expect(text(page, "n")).toBeVisible({ timeout: 15_000 });

    await pastePng(page, "n");
    await expect(page.locator(`li[data-node-id="n"] img`)).toBeVisible();

    await text(page, "n").click();
    await page.keyboard.type("X");
    await expect(text(page, "n")).toHaveText("helloX");

    await page.keyboard.press("ControlOrMeta+z");
    await expect(text(page, "n")).toHaveText("hello");
    await expect(page.getByText("Couldn't save your changes")).toHaveCount(0);
    await expect(page.locator(`li[data-node-id="n"] img`)).toBeVisible();
  });
});
