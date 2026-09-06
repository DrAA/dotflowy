import { expect, test, type Page } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isE2eLunora, seedOutline } from "./fixtures";

// Round-trip the user-facing content backup (Cmd+K Download / Restore),
// including hosted image bytes — whole outline and one-bullet restore.

const PNG_1x1_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const text = (page: Page, id: string) =>
  page.locator(`li[data-node-id="${id}"] > .outline-row .node-text`);

const row = (page: Page, id: string) =>
  page.locator(`li[data-node-id="${id}"]`);

interface CapturedDownload {
  filename: string;
  bytes: number[];
}

declare global {
  interface Window {
    __downloads?: Promise<CapturedDownload>[];
  }
}

async function interceptBinaryDownloads(page: Page) {
  await page.addInitScript(() => {
    window.__downloads = [];
    const blobs = new Map<string, Blob>();
    const origCreate = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (b: Blob | MediaSource) => {
      const url = origCreate(b);
      if (b instanceof Blob) blobs.set(url, b);
      return url;
    };
    HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
      const blob = blobs.get(this.href);
      if (!blob) return HTMLElement.prototype.click.call(this);
      const filename = this.download;
      window.__downloads!.push(
        blob.arrayBuffer().then((buf) => ({
          filename,
          bytes: Array.from(new Uint8Array(buf)),
        })),
      );
    };
  });
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

async function openPalette(page: Page) {
  await page.keyboard.press("ControlOrMeta+k");
  const input = page.getByPlaceholder(/Search nodes and actions/);
  await expect(input).toBeVisible();
  await input.click();
  return input;
}

async function downloadBackup(page: Page): Promise<string> {
  const downloadInput = await openPalette(page);
  await downloadInput.fill("download backup");
  await page.getByRole("option", { name: /Download backup/ }).click();
  await expect
    .poll(() => page.evaluate(() => window.__downloads!.length))
    .toBeGreaterThan(0);
  const download = await page.evaluate(() =>
    Promise.all(window.__downloads!).then((d) => d[d.length - 1]!),
  );
  expect(download.filename).toMatch(
    /^\d{4}-\d{2}-\d{2}-aaflowy-backup\.aaflowy-backup\.json\.gz$/,
  );
  const backupPath = join(tmpdir(), download.filename);
  writeFileSync(backupPath, Buffer.from(download.bytes));
  return backupPath;
}

async function openRestoreFile(page: Page, backupPath: string) {
  const restoreInput = await openPalette(page);
  await restoreInput.fill("restore backup");
  await page.getByRole("option", { name: /Restore backup/ }).click();
  await page
    .locator('input[type="file"][accept*="aaflowy-backup"]')
    .setInputFiles(backupPath);
}

test.describe("content backup restore", () => {
  test.skip(isE2eLunora(), "media mock rides classic /api/kv + /api/media");

  test("download then whole-outline restore brings bullets and images back", async ({
    page,
  }) => {
    await interceptBinaryDownloads(page);
    await seedOutline(page, [
      { id: "alpha", parentId: null, prevSiblingId: null, text: "Alpha" },
      { id: "bravo", parentId: null, prevSiblingId: "alpha", text: "Bravo" },
    ]);
    await page.goto("/");
    await expect(text(page, "bravo")).toBeVisible();

    await pastePng(page, "bravo");
    await expect(row(page, "bravo").locator("img")).toBeVisible();

    const backupPath = await downloadBackup(page);

    await text(page, "bravo").click();
    await page.keyboard.type(" /delete");
    await expect(page.getByRole("listbox")).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(row(page, "bravo")).toHaveCount(0);

    await openRestoreFile(page, backupPath);

    const dialog = page.getByTestId("content-backup-dialog");
    await expect(
      dialog.getByRole("heading", { name: "Restore from backup" }),
    ).toBeVisible();
    await dialog.getByTestId("content-backup-restore-whole").click();
    await expect(
      dialog.getByRole("heading", { name: "Replace whole outline?" }),
    ).toBeVisible();
    await dialog.getByRole("button", { name: "Replace outline" }).click();
    await expect(
      dialog.getByRole("heading", { name: "Backup restored" }),
    ).toBeVisible({ timeout: 30_000 });
    await expect(dialog.getByText(/1 images are back/)).toBeVisible();
    await dialog.getByRole("button", { name: "Done" }).click();

    await expect(row(page, "bravo")).toBeVisible();
    const restoredImg = row(page, "bravo").locator("img");
    await expect(restoredImg).toBeVisible();
    await expect
      .poll(async () =>
        restoredImg.evaluate(
          (el: HTMLImageElement) => el.complete && el.naturalWidth > 0,
        ),
      )
      .toBe(true);
  });

  test("one-bullet restore brings back a deleted branch and its image", async ({
    page,
  }) => {
    await interceptBinaryDownloads(page);
    await seedOutline(page, [
      { id: "alpha", parentId: null, prevSiblingId: null, text: "Alpha stay" },
      {
        id: "bravo",
        parentId: null,
        prevSiblingId: "alpha",
        text: "Bravo photo",
      },
      {
        id: "charlie",
        parentId: "bravo",
        prevSiblingId: null,
        text: "Charlie kid",
      },
    ]);
    await page.goto("/");
    await expect(text(page, "bravo")).toBeVisible();
    await pastePng(page, "bravo");
    await expect(row(page, "bravo").locator("img")).toBeVisible();

    const backupPath = await downloadBackup(page);

    // Delete only the branch; Alpha must survive a one-bullet restore.
    await text(page, "bravo").click();
    await page.keyboard.type(" /delete");
    await expect(page.getByRole("listbox")).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(row(page, "bravo")).toHaveCount(0);
    await expect(text(page, "alpha")).toBeVisible();

    await openRestoreFile(page, backupPath);
    const dialog = page.getByTestId("content-backup-dialog");
    await dialog.getByTestId("content-backup-restore-node").click();
    await dialog.getByTestId("content-backup-node-search").fill("Bravo photo");
    await dialog
      .getByTestId("content-backup-node-list")
      .getByRole("button", { name: /Bravo photo/ })
      .click();
    await expect(
      dialog.getByRole("heading", { name: "Restore this bullet?" }),
    ).toBeVisible();
    await dialog.getByRole("button", { name: "Restore bullet" }).click();
    await expect(
      dialog.getByRole("heading", { name: "Bullet restored" }),
    ).toBeVisible({ timeout: 30_000 });
    await dialog.getByRole("button", { name: "Done" }).click();

    await expect(text(page, "alpha")).toBeVisible();
    await expect(row(page, "bravo")).toBeVisible();
    await expect(row(page, "charlie")).toBeVisible();
    const img = row(page, "bravo").locator("img");
    await expect(img).toBeVisible();
    await expect
      .poll(async () =>
        img.evaluate(
          (el: HTMLImageElement) => el.complete && el.naturalWidth > 0,
        ),
      )
      .toBe(true);
  });
});
