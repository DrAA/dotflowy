import { expect, test, type Locator, type Page } from "@playwright/test";

import { seedOutline, type SeedNode } from "./fixtures";

// Rich links (ADR 0005): markdown `[label](url)` in node.text that always
// folds to a clean <a> (label + edit pencil). The caret never expands raw
// markdown into the line; label/url edits go through the Edit Link popover.
// These specs cover the fold, click-to-open, the Edit Link popover, copy/
// cut-as-source, and the paste paths.

const text = (page: Page, id: string) =>
  page.locator(`li[data-node-id="${id}"] > .outline-row .node-text`);

async function load(page: Page, tree: SeedNode[]) {
  // Record window.open calls so we can assert click-to-open without juggling
  // real popups.
  await page.addInitScript(() => {
    const state = window as unknown as {
      __opened: string[];
      __focusedTabs: number;
    };
    state.__opened = [];
    state.__focusedTabs = 0;
    window.open = ((url?: string | URL) => {
      state.__opened.push(String(url));
      return {
        opener: window,
        focus: () => {
          state.__focusedTabs += 1;
        },
      };
    }) as typeof window.open;
  });
  await seedOutline(page, tree);
  await page.goto("/");
  await expect(text(page, tree[0]!.id)).toBeVisible();
}

// Dispatch a synthetic paste carrying clipboard data. The caret/selection must
// already be set on `locator` -- the handler splices into the current range.
async function pasteInto(
  locator: Locator,
  data: { plain?: string; html?: string },
) {
  await locator.evaluate((el, d) => {
    const dt = new DataTransfer();
    if (d.plain) dt.setData("text/plain", d.plain);
    if (d.html) dt.setData("text/html", d.html);
    el.dispatchEvent(
      new ClipboardEvent("paste", {
        clipboardData: dt,
        bubbles: true,
        cancelable: true,
      }),
    );
  }, data);
}

// Focus a bullet WITHOUT clicking it (a click might land on a folded <a> and
// open it).
async function focusBullet(page: Page, id: string) {
  await text(page, id).evaluate((el: HTMLElement) => el.focus());
}

async function blurActive(page: Page) {
  await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
}

const opened = (page: Page) =>
  page.evaluate(() => (window as unknown as { __opened: string[] }).__opened);
const focusedTabs = (page: Page) =>
  page.evaluate(
    () => (window as unknown as { __focusedTabs: number }).__focusedTabs,
  );
const activeNodeId = (page: Page) =>
  page.evaluate(
    () =>
      document.activeElement
        ?.closest<HTMLElement>("[data-node-id]")
        ?.getAttribute("data-node-id") ?? null,
  );

const LINK = "[Anthropic](https://anthropic.com)";
const MOD = process.platform === "darwin" ? "Meta" : "Control";

// Mirror of readSource: a folded <a> contributes its data-src, every other
// node its textContent.
const readSrc = (page: Page, id: string) =>
  text(page, id).evaluate((el: HTMLElement) => {
    let out = "";
    const visit = (n: Node) => {
      if (n.nodeType === 3) {
        out += n.textContent ?? "";
        return;
      }
      const e = n as HTMLElement;
      if (e.hasAttribute?.("data-src")) {
        out += e.getAttribute("data-src") ?? "";
        return;
      }
      n.childNodes.forEach(visit);
    };
    el.childNodes.forEach(visit);
    return out;
  });

test.describe("Rich links stay folded", () => {
  test("a link folds to a clean <a> with no favicon; focus keeps it folded", async ({
    page,
  }) => {
    await load(page, [
      { id: "n", parentId: null, prevSiblingId: null, text: LINK },
    ]);

    const anchor = text(page, "n").locator("a[data-link]");
    await expect(anchor).toHaveText("Anthropic");
    await expect(anchor).toHaveAttribute("href", "https://anthropic.com");
    await expect(anchor.locator("img.link-favicon")).toHaveCount(0);
    await expect(anchor.locator(".link-edit-icon")).toHaveCount(1);

    // Focus keeps the clean <a> -- markdown never expands into the line.
    await focusBullet(page, "n");
    await expect(text(page, "n").locator("a[data-link]")).toHaveText(
      "Anthropic",
    );
    await expect(text(page, "n").locator(".link-reveal")).toHaveCount(0);
    await expect(text(page, "n")).not.toContainText("[");

    await blurActive(page);
    await expect(text(page, "n").locator("a[data-link]")).toHaveText(
      "Anthropic",
    );
  });

  test("clicking a folded link opens it in a new tab and stays folded", async ({
    page,
  }) => {
    await load(page, [
      { id: "n", parentId: null, prevSiblingId: null, text: LINK },
    ]);

    await text(page, "n").locator("a[data-link]").click();

    expect(await opened(page)).toEqual(["https://anthropic.com/"]);
    expect(await focusedTabs(page)).toBe(1);
    await expect(text(page, "n").locator("a[data-link]")).toBeVisible();
    await expect(text(page, "n").locator(".link-reveal")).toHaveCount(0);
  });

  test("Mod+Enter with caret on a folded link opens it instead of completing", async ({
    page,
  }) => {
    await load(page, [
      { id: "n", parentId: null, prevSiblingId: null, text: LINK },
    ]);

    await focusBullet(page, "n");
    // Caret at source offset 0 sits on the link token.
    await text(page, "n").evaluate((el: HTMLElement) => {
      const range = document.createRange();
      range.setStart(el, 0);
      range.collapse(true);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    });

    await page.keyboard.press(`${MOD}+Enter`);

    expect(await opened(page)).toEqual(["https://anthropic.com"]);
    expect(await focusedTabs(page)).toBe(1);
    await expect(text(page, "n")).toHaveAttribute("data-completed", "false");
    await expect(text(page, "n").locator("a[data-link]")).toBeVisible();
  });

  test("a multi-link line keeps every link folded under the caret", async ({
    page,
  }) => {
    const TWO = "[A](https://a.com) [B](https://b.com)";
    await load(page, [
      { id: "n", parentId: null, prevSiblingId: null, text: TWO },
    ]);

    await expect(text(page, "n").locator("a[data-link]")).toHaveCount(2);
    await focusBullet(page, "n");
    await expect(text(page, "n").locator("a[data-link]")).toHaveCount(2);
    await expect(text(page, "n").locator(".link-reveal")).toHaveCount(0);
    await expect(text(page, "n").locator("a[data-link]").nth(0)).toHaveText(
      "A",
    );
    await expect(text(page, "n").locator("a[data-link]").nth(1)).toHaveText(
      "B",
    );
  });
});

test.describe("Creating links by paste", () => {
  test("pasting a bare URL auto-links it and folds it immediately", async ({
    page,
  }) => {
    await page.route(
      (url) => url.pathname === "/api/unfurl",
      (route) =>
        route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({ title: null }),
        }),
    );
    await load(page, [
      { id: "n", parentId: null, prevSiblingId: null, text: "" },
    ]);

    await focusBullet(page, "n");
    await pasteInto(text(page, "n"), { plain: "https://example.com" });

    const anchor = text(page, "n").locator("a[data-link]");
    await expect(anchor).toHaveText("https://example.com");
    await expect(anchor).toHaveAttribute("href", "https://example.com");
    expect(await readSrc(page, "n")).toBe(
      "[https://example.com](https://example.com) ",
    );
  });

  test("pasting a URL over a selection wraps the selection as the label", async ({
    page,
  }) => {
    await load(page, [
      { id: "n", parentId: null, prevSiblingId: null, text: "Anthropic" },
    ]);

    await focusBullet(page, "n");
    await text(page, "n").evaluate((el: HTMLElement) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    });
    await pasteInto(text(page, "n"), { plain: "https://anthropic.com" });

    const anchor = text(page, "n").locator("a[data-link]");
    await expect(anchor).toHaveText("Anthropic");
    await expect(anchor).toHaveAttribute("href", "https://anthropic.com");
    expect(await readSrc(page, "n")).toBe(LINK);
  });

  test("pasting a rich link (single anchor) inserts [title](url) and folds it", async ({
    page,
  }) => {
    await load(page, [
      { id: "n", parentId: null, prevSiblingId: null, text: "" },
    ]);

    await focusBullet(page, "n");
    await pasteInto(text(page, "n"), {
      html: '<meta charset="utf-8"><a href="https://anthropic.com">Anthropic</a>',
      plain: "Anthropic",
    });

    const anchor = text(page, "n").locator("a[data-link]");
    await expect(anchor).toHaveText("Anthropic");
    await expect(anchor).toHaveAttribute("href", "https://anthropic.com");
    expect(await readSrc(page, "n")).toBe(`${LINK} `);
  });

  test("pasting richer HTML with a link in surrounding text still linkifies", async ({
    page,
  }) => {
    await load(page, [
      { id: "n", parentId: null, prevSiblingId: null, text: "" },
    ]);

    await focusBullet(page, "n");
    await pasteInto(text(page, "n"), {
      html: '<span>See <a href="https://anthropic.com">Anthropic</a> now</span>',
      plain: "See Anthropic now",
    });

    const anchor = text(page, "n").locator("a[data-link]");
    await expect(anchor).toHaveText("Anthropic");
    await expect(anchor).toHaveAttribute("href", "https://anthropic.com");
    expect(await readSrc(page, "n")).toBe(`See ${LINK} now`);
  });

  test("URLs with parens are percent-encoded so the link still parses", async ({
    page,
  }) => {
    await load(page, [
      { id: "n", parentId: null, prevSiblingId: null, text: "" },
    ]);

    await focusBullet(page, "n");
    await pasteInto(text(page, "n"), {
      plain: "https://en.wikipedia.org/wiki/Foo_(bar)",
    });

    const anchor = text(page, "n").locator("a[data-link]");
    await expect(anchor).toHaveAttribute(
      "href",
      "https://en.wikipedia.org/wiki/Foo_%28bar%29",
    );
    expect(await readSrc(page, "n")).toBe(
      "[https://en.wikipedia.org/wiki/Foo_(bar)](https://en.wikipedia.org/wiki/Foo_%28bar%29) ",
    );
  });

  test("pasting a bare URL fetches its title and swaps it into the label", async ({
    page,
  }) => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    await page.route(
      (url) => url.pathname === "/api/unfurl",
      async (route) => {
        await gate;
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({ title: "Anthropic" }),
        });
      },
    );

    await load(page, [
      { id: "n", parentId: null, prevSiblingId: null, text: "" },
    ]);
    await focusBullet(page, "n");
    await pasteInto(text(page, "n"), { plain: "https://anthropic.com" });

    const anchor = text(page, "n").locator("a[data-link]");
    await expect(anchor).toHaveClass(/link-unfurling/);
    await expect(anchor).toHaveText("https://anthropic.com");

    release();

    const swapped = text(page, "n").locator("a[data-link]");
    await expect(swapped).toHaveText("Anthropic");
    await expect(swapped).not.toHaveClass(/link-unfurling/);
    expect(await readSrc(page, "n")).toBe(
      "[Anthropic](https://anthropic.com) ",
    );
  });

  test("a failed title fetch keeps the url placeholder", async ({ page }) => {
    await page.route(
      (url) => url.pathname === "/api/unfurl",
      (route) =>
        route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({ title: null }),
        }),
    );

    await load(page, [
      { id: "n", parentId: null, prevSiblingId: null, text: "" },
    ]);
    await focusBullet(page, "n");
    await pasteInto(text(page, "n"), { plain: "https://anthropic.com" });

    const anchor = text(page, "n").locator("a[data-link]");
    await expect(anchor).toHaveText("https://anthropic.com");
    await expect(anchor).not.toHaveClass(/link-unfurling/);
    expect(await readSrc(page, "n")).toBe(
      "[https://anthropic.com](https://anthropic.com) ",
    );
  });
});

test.describe("Edit Link popover", () => {
  const popover = (page: Page) => page.locator("[data-link-edit-popover]");

  test("the pencil opens the editor; Done rewrites label and url; stays folded", async ({
    page,
  }) => {
    await load(page, [
      {
        id: "n",
        parentId: null,
        prevSiblingId: null,
        text: `before ${LINK} after`,
      },
    ]);

    await text(page, "n").locator("a[data-link] .link-edit-icon").click();

    await expect(popover(page)).toBeVisible();
    await expect(popover(page).getByLabel("Link text")).toHaveValue(
      "Anthropic",
    );
    await expect(popover(page).getByLabel("Link URL")).toHaveValue(
      "https://anthropic.com",
    );
    expect(await opened(page)).toEqual([]);
    // Still folded while the popover is open -- no markdown reveal.
    await expect(text(page, "n").locator("a[data-link]")).toBeVisible();
    await expect(text(page, "n").locator(".link-reveal")).toHaveCount(0);

    await popover(page).getByLabel("Link text").fill("Claude");
    await popover(page).getByLabel("Link URL").fill("https://claude.ai");
    await popover(page).getByRole("button", { name: "Done" }).click();

    await expect(popover(page)).toHaveCount(0);
    await expect.poll(() => activeNodeId(page)).toBe("n");
    const anchor = text(page, "n").locator("a[data-link]");
    await expect(anchor).toHaveText("Claude");
    await expect(anchor).toHaveAttribute("href", "https://claude.ai");
    expect(await readSrc(page, "n")).toBe(
      "before [Claude](https://claude.ai) after",
    );
  });

  test("Cancel leaves the link untouched", async ({ page }) => {
    await load(page, [
      { id: "n", parentId: null, prevSiblingId: null, text: LINK },
    ]);

    await text(page, "n").locator("a[data-link] .link-edit-icon").click();
    await popover(page).getByLabel("Link text").fill("changed");
    await popover(page).getByRole("button", { name: "Cancel" }).click();

    await expect(popover(page)).toHaveCount(0);
    await expect.poll(() => activeNodeId(page)).toBe("n");
    expect(await readSrc(page, "n")).toBe(LINK);
  });
});

test.describe("Copy and cut return markdown source", () => {
  const SRC = `before ${LINK} after`;

  const clip = (page: Page, id: string, type: "copy" | "cut") =>
    text(page, id).evaluate((el: HTMLElement, t) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);
      const dt = new DataTransfer();
      el.dispatchEvent(
        new ClipboardEvent(t, {
          clipboardData: dt,
          bubbles: true,
          cancelable: true,
        }),
      );
      return {
        plain: dt.getData("text/plain"),
        html: dt.getData("text/html"),
      };
    }, type);

  test("copying a selection spanning a folded link yields the markdown", async ({
    page,
  }) => {
    await load(page, [
      { id: "n", parentId: null, prevSiblingId: null, text: SRC },
    ]);

    const { plain, html } = await clip(page, "n", "copy");
    expect(plain).toBe(SRC);
    expect(html).toContain("<!--StartFragment-->");
    expect(html).toContain('<a href="https://anthropic.com">Anthropic</a>');
    expect(html).toContain("before ");
    expect(html).toContain(" after");
    await expect(text(page, "n").locator("a[data-link]")).toHaveText(
      "Anthropic",
    );
  });

  test("cut yields the markdown and removes the selection in source space", async ({
    page,
  }) => {
    await load(page, [
      { id: "n", parentId: null, prevSiblingId: null, text: SRC },
    ]);

    const { plain } = await clip(page, "n", "cut");
    expect(plain).toBe(SRC);
    await expect(text(page, "n")).toHaveText("");
  });
});
