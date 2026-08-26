// Regression: a lagging store-sync effect used to rewind the caret one
// character while typing (especially a fast burst). The focused bullet must
// keep the caret at the live insert point.

import { expect, test, type Page } from "@playwright/test";

import { seedOutline, type SeedNode } from "./fixtures";

const text = (page: Page, id: string) =>
  page.locator(`li[data-node-id="${id}"] > .outline-row .node-text`);

const TREE: SeedNode[] = [
  { id: "type", parentId: null, prevSiblingId: null, text: "base" },
];

async function load(page: Page) {
  await seedOutline(page, TREE);
  await page.goto("/");
  await expect(text(page, "type")).toBeVisible({ timeout: 15_000 });
}

/** Absolute source offset of the collapsed caret inside `id`'s bullet. */
async function sourceCaret(page: Page, id: string): Promise<number> {
  return text(page, id).evaluate((el) => {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return -1;
    const range = sel.getRangeAt(0);
    if (!el.contains(range.endContainer)) return -1;
    let total = 0;
    let found = false;
    const visit = (node: Node) => {
      if (found) return;
      if (node.nodeType === 3) {
        if (node === range.endContainer) {
          total += range.endOffset;
          found = true;
        } else {
          total += node.textContent?.length ?? 0;
        }
        return;
      }
      node.childNodes.forEach(visit);
    };
    visit(el);
    return total;
  });
}

test.describe("fast typing caret", () => {
  test("caret stays at the end of a rapid burst", async ({ page }) => {
    await load(page);
    await text(page, "type").click();
    await text(page, "type").evaluate((el) => {
      const sel = window.getSelection();
      if (!sel) return;
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
    });
    const typed = "the quick brown fox jumps";
    await page.keyboard.type(typed, { delay: 0 });
    await expect(text(page, "type")).toHaveText("base" + typed);
    expect(await sourceCaret(page, "type")).toBe(("base" + typed).length);
  });

  test("caret stays at the insert point in the middle of a line", async ({
    page,
  }) => {
    await seedOutline(page, [
      { id: "type", parentId: null, prevSiblingId: null, text: "hello" },
    ]);
    await page.goto("/");
    await expect(text(page, "type")).toBeVisible({ timeout: 15_000 });
    await text(page, "type").click();
    // Land between 'e' and 'l' (source offset 2), then type a burst there.
    await text(page, "type").evaluate((el) => {
      const sel = window.getSelection();
      if (!sel) return;
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      const node = walker.nextNode();
      if (!node) return;
      const range = document.createRange();
      range.setStart(node, 2);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
    });
    await page.keyboard.type("XY", { delay: 0 });
    await expect(text(page, "type")).toHaveText("heXYllo");
    expect(await sourceCaret(page, "type")).toBe(4);
  });
});
