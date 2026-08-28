import { expect, test, type Page } from "@playwright/test";

import { seedOutline, STANDARD_TREE, type SeedNode } from "./fixtures";

const text = (page: Page, id: string) =>
  page.locator(`li[data-node-id="${id}"] > .outline-row .node-text`);

const zoomedTitle = (page: Page) => page.locator(".zoomed-title .node-text");

async function load(page: Page, tree: SeedNode[] = STANDARD_TREE) {
  await seedOutline(page, tree);
  await page.goto("/");
  await expect(text(page, tree[0]!.id)).toBeVisible({ timeout: 15_000 });
}

test.describe("document title", () => {
  test("home is just the brand; zoom prefixes the top node", async ({
    page,
  }) => {
    await load(page);
    await expect(page).toHaveTitle("aaflowy");

    await page.goto("/alpha");
    await expect(zoomedTitle(page)).toBeVisible();
    await expect(page).toHaveTitle("Alpha - aaflowy");
  });

  test("a rename of the zoomed node updates the tab title", async ({
    page,
  }) => {
    await load(page);
    await page.goto("/alpha");
    await expect(zoomedTitle(page)).toBeVisible();
    await expect(page).toHaveTitle("Alpha - aaflowy");

    await zoomedTitle(page).click();
    await zoomedTitle(page).evaluate((el: HTMLElement) => {
      const sel = window.getSelection();
      if (!sel) return;
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
    });
    await page.keyboard.type(" renamed");
    await expect(page).toHaveTitle("Alpha renamed - aaflowy");
  });

  test("markup in the zoomed title flattens to reading text", async ({
    page,
  }) => {
    await load(page, [
      {
        id: "alpha",
        parentId: null,
        prevSiblingId: null,
        text: "**Sprint goals**",
      },
    ]);
    await page.goto("/alpha");
    await expect(zoomedTitle(page)).toBeVisible();
    await expect(page).toHaveTitle("Sprint goals - aaflowy");
  });

  test("zooming out restores the brand-only title", async ({ page }) => {
    await load(page);
    await page.goto("/alpha");
    await expect(page).toHaveTitle("Alpha - aaflowy");

    await page.locator("nav.breadcrumb button").first().click();
    await expect(text(page, "alpha")).toBeVisible();
    await expect(page).toHaveTitle("aaflowy");
  });
});
