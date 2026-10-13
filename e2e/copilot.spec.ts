import { expect, test, type Page } from "@playwright/test";

import { seedOutline, type SeedNode } from "./fixtures";

const text = (page: Page, id: string) =>
  page.locator(`li[data-node-id="${id}"] > .outline-row .node-text`);

async function mockCopilotApi(page: Page) {
  await page.route(
    (url) => url.pathname === "/api/copilot/status",
    async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          configured: true,
          connected: true,
          mock: true,
        }),
      });
    },
  );
  await page.route(
    (url) => url.pathname === "/api/copilot/chat",
    async (route) => {
      const body = route.request().postDataJSON() as { prompt?: string };
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          text: `Copilot (mock): ${(body.prompt ?? "").trim()}`,
        }),
      });
    },
  );
}

async function load(page: Page, tree: SeedNode[]) {
  await mockCopilotApi(page);
  await seedOutline(page, tree);
  await page.goto("/");
  await expect(text(page, tree[0]!.id)).toBeVisible();
}

async function openCopilot(page: Page, id: string) {
  await text(page, id).click();
  await expect(text(page, id)).toBeFocused();
  await page.keyboard.type(" /copilot");
  await expect(page.getByRole("listbox")).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog")).toBeVisible();
}

test.describe("/copilot", () => {
  test("prompt dialog replaces the bullet text with the reply", async ({
    page,
  }) => {
    await load(page, [
      {
        id: "alpha",
        parentId: null,
        prevSiblingId: null,
        text: "Ask me something",
      },
    ]);
    await openCopilot(page, "alpha");
    await page
      .getByPlaceholder(/look up or summarize/i)
      .fill("Friday meetings");
    await page.getByRole("button", { name: "Ask Copilot" }).click();
    await expect(page.getByRole("dialog")).toBeHidden();
    await expect(text(page, "alpha")).toHaveText(
      "Copilot (mock): Friday meetings",
    );
  });
});
