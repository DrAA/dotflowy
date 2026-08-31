import { expect, test, type Page } from "@playwright/test";

import { isE2eLunora, seedOutline, STANDARD_TREE } from "./fixtures";

// A node's own editable text span.
const text = (page: Page, id: string) =>
  page.locator(`li[data-node-id="${id}"] > .outline-row .node-text`);

// Every visible bullet's raw text in document order (empty new bullets show as
// ""), so a queued insert stays visible instead of rolling back.
const orderedTexts = (page: Page) =>
  page.locator(".outline-row .node-text").allTextContents();

const persistQueuedToast = (page: Page) =>
  page.locator("[data-sonner-toast]", {
    hasText: "Changes not saved yet",
  });

// Drop the caret at the end of a bullet (Home/End/arrows are unreliable in
// macOS Chromium contentEditable; setting the Selection directly is not needed
// here since a fresh Enter appends at the caret we place by clicking the end).
async function caretAtEnd(page: Page, id: string) {
  const el = text(page, id);
  await el.click();
  await el.evaluate((node) => {
    const sel = window.getSelection();
    if (!sel) return;
    const range = document.createRange();
    range.selectNodeContents(node);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
  });
}

test.describe("Save failure queues edits and warns (#230)", () => {
  test("a failed structural write toasts and keeps the optimistic bullet", async ({
    page,
  }) => {
    test.skip(
      isE2eLunora(),
      "injects a failure into the classic structural transport",
    );
    // Seed loads normally; only structural-batch POSTs fail from here on.
    await seedOutline(page, STANDARD_TREE, { failStructuralWrites: true });
    await page.goto("/");
    await expect(text(page, "alpha")).toBeVisible();

    const before = await orderedTexts(page);

    // Enter at the end of "Alpha" is a structural insert (new sibling bullet) —
    // it routes through runStructural, whose batch POST the mock now 500s.
    await caretAtEnd(page, "alpha");
    await page.keyboard.press("Enter");

    // The warning toast appears...
    await expect(persistQueuedToast(page)).toBeVisible({ timeout: 10_000 });
    await expect(
      page.locator('[data-testid="save-status-indicator"][data-ok="false"]'),
    ).toBeVisible();

    // ...and the optimistic new bullet stays: one more row than before.
    await expect
      .poll(() => orderedTexts(page).then((t) => t.length), {
        timeout: 10_000,
      })
      .toBe(before.length + 1);
  });

  test("queued edits survive a reload while still offline", async ({
    page,
  }) => {
    test.skip(
      isE2eLunora(),
      "injects a failure into the classic structural transport",
    );
    await seedOutline(page, STANDARD_TREE, { failStructuralWrites: true });
    await page.goto("/");
    await expect(text(page, "alpha")).toBeVisible();

    const before = await orderedTexts(page);
    await caretAtEnd(page, "alpha");
    await page.keyboard.press("Enter");

    await expect(persistQueuedToast(page)).toBeVisible({ timeout: 10_000 });
    await expect
      .poll(() => orderedTexts(page).then((t) => t.length), {
        timeout: 10_000,
      })
      .toBe(before.length + 1);

    // Reload before the network path succeeds — queue + snapshot live in
    // localStorage and should repaint the extra bullet after bootstrap.
    await page.reload();
    await expect(text(page, "alpha")).toBeVisible({ timeout: 15_000 });
    await expect
      .poll(() => orderedTexts(page).then((t) => t.length), {
        timeout: 15_000,
      })
      .toBe(before.length + 1);
    await expect(persistQueuedToast(page)).toBeVisible({ timeout: 10_000 });
  });
});
