import { expect, test, type Page } from "@playwright/test";

import { isE2eLunora, seedOutline } from "./fixtures";

// 1×1 PNG. Bytes are tiny; the mock /api/media path stores them as-is.
const PNG_1x1_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const text = (page: Page, id: string) =>
  page.locator(`li[data-node-id="${id}"] > .outline-row .node-text`);

const row = (page: Page, id: string) =>
  page.locator(`li[data-node-id="${id}"]`);

async function slashDelete(page: Page, id: string) {
  await text(page, id).click({ force: true });
  await expect(text(page, id)).toBeFocused();
  await page.keyboard.type(" /delete");
  await expect(page.getByRole("listbox")).toBeVisible();
  await expect(
    page.getByRole("option", { name: "Delete", exact: false }),
  ).toBeVisible();
  await page.keyboard.press("Enter");
}

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

test.describe("hosted image under a bullet", () => {
  test.skip(isE2eLunora(), "media mock rides classic /api/kv + /api/media");

  test("paste PNG, survive reload, GC kv on /delete", async ({ page }) => {
    await seedOutline(page, [
      { id: "alpha", parentId: null, prevSiblingId: null, text: "Alpha" },
      { id: "bravo", parentId: null, prevSiblingId: "alpha", text: "Bravo" },
    ]);
    await page.goto("/");
    await expect(text(page, "bravo")).toBeVisible();

    await pastePng(page, "bravo");
    const img = row(page, "bravo").locator("img");
    await expect(img).toBeVisible();
    await expect(img).toHaveAttribute("src", /\/api\/media\//);

    const src = await img.getAttribute("src");
    const mediaId = src?.split("/api/media/")[1]?.split(/[?#]/)[0];
    expect(mediaId).toBeTruthy();

    await page.reload();
    await expect(row(page, "bravo").locator("img")).toBeVisible();
    await expect(row(page, "bravo").locator("img")).toHaveAttribute(
      "src",
      `/api/media/${mediaId}`,
    );

    await slashDelete(page, "bravo");
    await expect(row(page, "bravo")).toHaveCount(0);

    const status = await page.evaluate(async (id) => {
      const res = await fetch(`/api/media/${id}`);
      return res.status;
    }, mediaId);
    expect(status).toBe(404);
  });
});
