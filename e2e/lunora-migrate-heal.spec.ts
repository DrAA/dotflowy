import { expect, test, type Page } from "@playwright/test";

import { localDateKey } from "../src/data/date-links";
import { seedOutlineLunora, type SeedNode } from "./fixtures";

/**
 * ADR 0058 migrate heal: Lunora already has outline nodes (partial migrate)
 * but daily-index never landed. Classic KV still has the mapping — flag ON
 * must backfill KV so Today is not empty.
 */

const todayButton = (page: Page) =>
  page.getByRole("button", { name: "Today's daily note" });

test.describe("Lunora classic→Lunora migrate heal", () => {
  test("partial migrate backfills daily-index so Today keeps the same node", async ({
    page,
  }) => {
    const dayKey = localDateKey();
    const year = String(new Date().getFullYear());

    const tree: SeedNode[] = [
      {
        id: "daily-container",
        parentId: null,
        prevSiblingId: null,
        text: "Daily",
      },
      {
        id: "today-day",
        parentId: "daily-container",
        prevSiblingId: null,
        text: `Tuesday, July 26, ${year}`,
      },
      {
        id: "migrated-note",
        parentId: "today-day",
        prevSiblingId: null,
        text: "MigratedNote",
      },
    ];

    // Lunora has the nodes (bug state: skipped-nonempty) but no Lunora kv.
    // Classic still holds daily-index → heal must import it.
    await seedOutlineLunora(page, tree, {
      classicSource: {
        nodes: tree,
        kv: {
          "daily-index": [
            {
              key: "container",
              value: { key: "container", nodeId: "daily-container" },
            },
            {
              key: dayKey,
              value: { key: dayKey, nodeId: "today-day" },
            },
          ],
        },
      },
    });

    await page.goto("/");
    // Nodes paint before KV heal finishes — wait for the daily badge that only
    // appears once classic daily-index has been imported into Lunora.
    await expect(
      page.locator(
        `li[data-node-id="today-day"] [data-daily-date="${dayKey}"]`,
      ),
    ).toBeVisible({ timeout: 15_000 });

    await todayButton(page).click();
    await expect(page).toHaveURL(/\/today-day/);
    await expect(
      page.locator(
        'li[data-node-id="migrated-note"] > .outline-row .node-text',
      ),
    ).toHaveText("MigratedNote");
    await expect(
      page.locator(`h2.zoomed-title [data-daily-date="${dayKey}"]`),
    ).toBeVisible();
  });
});
