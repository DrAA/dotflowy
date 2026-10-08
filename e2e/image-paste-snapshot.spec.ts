// Regression: mid-session classic WS snapshot (same path as overnight typing)
// must not drop a pasted image that already rendered under a bullet.
import { expect, test, type Page } from "@playwright/test";

import {
  isE2eLunora,
  pushClassicSyncSnapshot,
  seedOutline,
  type SeedNode,
} from "./fixtures";

const PNG_1x1_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const text = (page: Page, id: string) =>
  page.locator(`li[data-node-id="${id}"] > .outline-row .node-text`);

const row = (page: Page, id: string) =>
  page.locator(`li[data-node-id="${id}"]`);

const TREE: SeedNode[] = [
  { id: "n", parentId: null, prevSiblingId: null, text: "base" },
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

test.describe("image paste vs mid-session snapshot", () => {
  test.skip(isE2eLunora(), "classic /api/sync snapshot path only");

  test("pasted image survives a delayed classic snapshot", async ({ page }) => {
    const deletes: string[] = [];
    page.on("request", (req) => {
      const method = req.method();
      if (method !== "DELETE") return;
      const url = req.url();
      if (url.includes("/api/media") || url.includes("/api/kv")) {
        deletes.push(`${method} ${url}`);
      }
    });
    page.on("console", (msg) => {
      if (msg.type() === "error") deletes.push(`console: ${msg.text()}`);
    });

    await seedOutline(page, TREE);
    await page.goto("/");
    await expect(text(page, "n")).toBeVisible({ timeout: 15_000 });

    await pastePng(page, "n");
    const img = row(page, "n").locator("img");
    await expect(img).toBeVisible();
    await expect(img).toHaveAttribute("src", /\/api\/media\//);

    const src = await img.getAttribute("src");
    expect(src).toBeTruthy();

    pushClassicSyncSnapshot();
    await page.waitForTimeout(1200);

    await expect(row(page, "n").locator("img")).toBeVisible();
    await expect(row(page, "n").locator("img")).toHaveAttribute("src", src!);

    // Surfaced in the report if the assertion fails; empty on a clean pass.
    expect(
      deletes,
      `unexpected media/kv DELETE during snapshot: ${deletes.join("; ")}`,
    ).toEqual([]);
  });

  test("pasted image survives snapshot raced against delayed media POST", async ({
    page,
  }) => {
    const deletes: string[] = [];
    page.on("request", (req) => {
      const method = req.method();
      if (method !== "DELETE") return;
      const url = req.url();
      if (url.includes("/api/media") || url.includes("/api/kv")) {
        deletes.push(`${method} ${url}`);
      }
    });

    // Hold the media POST so the snapshot can land while upload is in flight.
    await seedOutline(page, TREE, { mediaPostDelayMs: 800 });
    await page.goto("/");
    await expect(text(page, "n")).toBeVisible({ timeout: 15_000 });

    await pastePng(page, "n");
    // Do not wait for img — push while POST is still delayed.
    pushClassicSyncSnapshot();

    const img = row(page, "n").locator("img");
    await expect(img).toBeVisible({ timeout: 15_000 });
    await expect(img).toHaveAttribute("src", /\/api\/media\//);
    const src = await img.getAttribute("src");
    expect(src).toBeTruthy();

    await page.waitForTimeout(1200);
    await expect(row(page, "n").locator("img")).toBeVisible();
    await expect(row(page, "n").locator("img")).toHaveAttribute("src", src!);
    expect(
      deletes,
      `unexpected media/kv DELETE during race: ${deletes.join("; ")}`,
    ).toEqual([]);
  });
});
