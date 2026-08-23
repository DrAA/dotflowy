import { expect, test } from "@playwright/test";

test.describe("Browser-only data (opt-in)", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem("dotflowy:flag:local-data", "on");
    });
  });

  test("opens the outline without signing in and keeps welcome bullets after reload", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page.getByText("Welcome to aaflowy")).toBeVisible({
      timeout: 20_000,
    });
    await page.reload();
    await expect(page.getByText("Welcome to aaflowy")).toBeVisible();
  });

  test("Settings shows This browser only on, and hides cloud account chrome", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page.getByText("Welcome to aaflowy")).toBeVisible({
      timeout: 20_000,
    });
    await page.goto("/settings");
    await expect(
      page.getByRole("switch", { name: /this browser only/i }),
    ).toBeChecked();
    await expect(
      page.getByRole("heading", { name: "Plan & billing" }),
    ).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Account" })).toHaveCount(0);
  });
});
