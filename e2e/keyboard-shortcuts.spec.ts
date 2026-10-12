import { expect, test } from "@playwright/test";

import { seedOutline } from "./fixtures";

test.describe("Keyboard shortcuts dialog", () => {
  test("Mod+/ opens and toggles the shortcuts dialog", async ({ page }) => {
    await seedOutline(page, [
      { id: "a", parentId: null, prevSiblingId: null, text: "alpha" },
    ]);
    await page.goto("/");
    await expect(
      page.locator('li[data-node-id="a"] > .outline-row .node-text'),
    ).toBeVisible();

    await page.keyboard.press("Control+/");
    const dialog = page.getByRole("dialog", { name: "Keyboard shortcuts" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("Open the command center")).toBeVisible();

    await page.keyboard.press("Control+/");
    await expect(dialog).toHaveCount(0);
  });

  test("More menu → Keyboard shortcuts opens the dialog", async ({ page }) => {
    await seedOutline(page, [
      { id: "a", parentId: null, prevSiblingId: null, text: "alpha" },
    ]);
    await page.goto("/");
    await expect(
      page.locator('li[data-node-id="a"] > .outline-row .node-text'),
    ).toBeVisible();

    await page.getByRole("button", { name: /More actions/ }).click();
    await page.getByRole("menuitem", { name: "Keyboard shortcuts" }).click();
    await expect(
      page.getByRole("dialog", { name: "Keyboard shortcuts" }),
    ).toBeVisible();
  });
});
