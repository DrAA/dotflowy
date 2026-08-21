import { expect, test, type Page } from "@playwright/test";

import { seedOutline, STANDARD_TREE, type SeedNode } from "./fixtures";

// A node's OWN editable text span and its content row (the element that dims).
const text = (page: Page, id: string) =>
  page.locator(`li[data-node-id="${id}"] > .outline-row .node-text`);
const row = (page: Page, id: string) =>
  page.locator(`li[data-node-id="${id}"] > .outline-row`);

// Enable spotlight before any app script runs, so the toggle store's first
// snapshot is already `true` and the controller installs on mount.
async function loadWithSpotlight(page: Page, on: boolean) {
  await seedOutline(page, STANDARD_TREE);
  if (on) {
    await page.addInitScript(() => {
      window.localStorage.setItem("dotflowy:spotlight", "true");
    });
  }
  await page.goto("/");
  await expect(text(page, "alpha")).toBeVisible();
}

// Spotlight focus mode (ADR 0033): while a bullet is focused, every other row
// dims to 0.3 and ONLY the focused bullet stays full (single-node -- ancestors
// dim too). Pure CSS via `.spotlight-on:has(.node-text:focus)` + `:focus-within`.
test.describe("spotlight focus mode", () => {
  test("focusing a bullet lights only it and dims everything else", async ({
    page,
  }) => {
    await loadWithSpotlight(page, true);

    // Mode is on, but with no caret in the outline nothing dims (`:has` fails).
    await expect(row(page, "alpha")).toHaveCSS("opacity", "1");
    await expect(row(page, "bravo")).toHaveCSS("opacity", "1");

    await text(page, "alpha-1").click();
    await expect(text(page, "alpha-1")).toBeFocused();

    // Only the focused bullet is full...
    await expect(row(page, "alpha-1")).toHaveCSS("opacity", "1");
    // ...its parent dims like everything else (single-node, no ancestor chain)...
    await expect(row(page, "alpha")).toHaveCSS("opacity", "0.3");
    // ...as do a sibling and an unrelated top-level node.
    await expect(row(page, "alpha-2")).toHaveCSS("opacity", "0.3");
    await expect(row(page, "bravo")).toHaveCSS("opacity", "0.3");
  });

  test("the lit bullet follows the caret", async ({ page }) => {
    await loadWithSpotlight(page, true);

    await text(page, "alpha-1").click();
    await expect(row(page, "alpha-1")).toHaveCSS("opacity", "1");
    await expect(row(page, "bravo")).toHaveCSS("opacity", "0.3");

    await text(page, "bravo").click();
    await expect(row(page, "bravo")).toHaveCSS("opacity", "1");
    await expect(row(page, "alpha-1")).toHaveCSS("opacity", "0.3");
  });

  test("blurring the outline returns every row to full opacity", async ({
    page,
  }) => {
    await loadWithSpotlight(page, true);
    await text(page, "alpha-1").click();
    await expect(row(page, "bravo")).toHaveCSS("opacity", "0.3");

    // No caret -> `:has(.node-text:focus)` fails -> nothing is dimmed.
    await page.evaluate(() =>
      (document.activeElement as HTMLElement | null)?.blur(),
    );
    await expect(row(page, "bravo")).toHaveCSS("opacity", "1");
    await expect(row(page, "alpha-1")).toHaveCSS("opacity", "1");
  });

  test("zoomed in, the page title dims while a child bullet is focused", async ({
    page,
  }) => {
    await seedOutline(page, STANDARD_TREE);
    await page.addInitScript(() => {
      window.localStorage.setItem("dotflowy:spotlight", "true");
    });
    // Zoom into alpha: it now renders as the h2 page title, alpha-1 a child row.
    await page.goto("/alpha");
    const title = page.locator("h2.zoomed-title");
    const titleText = page.locator("h2.zoomed-title .node-text");
    await expect(titleText).toBeVisible();

    // Focus a child bullet -> the title dims like any parent, the child is full.
    await text(page, "alpha-1").click();
    await expect(text(page, "alpha-1")).toBeFocused();
    await expect(title).toHaveCSS("opacity", "0.3");
    await expect(row(page, "alpha-1")).toHaveCSS("opacity", "1");

    // Focus the title itself -> it's the caret's node now, so it stays full.
    await titleText.click();
    await expect(titleText).toBeFocused();
    await expect(title).toHaveCSS("opacity", "1");
  });

  test("with the mode off, focusing dims nothing", async ({ page }) => {
    await loadWithSpotlight(page, false);
    await text(page, "alpha-1").click();
    await expect(text(page, "alpha-1")).toBeFocused();

    await expect(page.locator("body")).not.toHaveClass(/spotlight-on/);
    await expect(row(page, "bravo")).toHaveCSS("opacity", "1");
  });
});

// The header indicator (ADR 0033): a chip that is present ONLY while spotlight
// is on -- the passive at-rest awareness signal (the dim only shows while a
// caret is in the outline) AND the one-click off-switch. Its presence == the
// mode is active; clicking it turns the mode off, so the chip disappears.
test.describe("spotlight header indicator", () => {
  const indicator = (page: Page) => page.locator("[data-spotlight-indicator]");

  test("is absent when spotlight is off", async ({ page }) => {
    await loadWithSpotlight(page, false);
    await expect(indicator(page)).toHaveCount(0);
  });

  test("is present at rest when spotlight is on (no caret needed)", async ({
    page,
  }) => {
    await loadWithSpotlight(page, true);
    // No bullet focused: the dim shows nothing, but the chip still signals on.
    await expect(indicator(page)).toBeVisible();
  });

  test("clicking it turns spotlight off: chip vanishes and dimming stops", async ({
    page,
  }) => {
    await loadWithSpotlight(page, true);
    await expect(indicator(page)).toBeVisible();

    // Turn the mode off from the header.
    await indicator(page).click();
    await expect(indicator(page)).toHaveCount(0);
    await expect(page.locator("body")).not.toHaveClass(/spotlight-on/);

    // Focusing a bullet no longer dims its neighbors.
    await text(page, "alpha-1").click();
    await expect(text(page, "alpha-1")).toBeFocused();
    await expect(row(page, "bravo")).toHaveCSS("opacity", "1");
  });
});

// Typewriter centering (ADR 0060): while spotlight is on, a focused list row
// is scrolled to the vertical center of the visual viewport. Needs a tree
// taller than the viewport so the page can actually scroll.
const TALL: SeedNode[] = Array.from({ length: 40 }, (_, i) => ({
  id: `n${i}`,
  parentId: null,
  prevSiblingId: i === 0 ? null : `n${i - 1}`,
  text: `line${i}`,
}));

async function loadTall(page: Page, on: boolean) {
  await seedOutline(page, TALL);
  if (on) {
    await page.addInitScript(() => {
      window.localStorage.setItem("dotflowy:spotlight", "true");
    });
  }
  await page.goto("/");
  await expect(text(page, "n0")).toBeVisible({ timeout: 15_000 });
}

// Poll waits out the 240ms typewriter slide (ADR 0060).
function offsetFromViewportCenter(page: Page, id: string) {
  return page.evaluate((nodeId) => {
    const el = document.querySelector(`li[data-node-id="${nodeId}"]`);
    if (!(el instanceof HTMLElement)) return Infinity;
    const rect = el.getBoundingClientRect();
    const viewTop = window.visualViewport?.offsetTop ?? 0;
    const viewHeight = window.visualViewport?.height ?? window.innerHeight;
    return Math.abs(rect.top + rect.height / 2 - (viewTop + viewHeight / 2));
  }, id);
}

async function caretOn(page: Page, id: string) {
  await text(page, id).evaluate((el) => {
    (el as HTMLElement).focus();
    const sel = window.getSelection();
    if (!sel) return;
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
  });
}

test.describe("spotlight typewriter centering", () => {
  test("first paint with the mode already on puts n0 at the list top, not in the well", async ({
    page,
  }) => {
    await loadTall(page, true);
    let metrics: {
      n0Top: number;
      scrollY: number;
      viewH: number;
    } | null = null;
    await expect
      .poll(async () => {
        metrics = await page.evaluate(() => {
          const n0 = document.querySelector('li[data-node-id="n0"]');
          if (!(n0 instanceof HTMLElement)) return null;
          return {
            n0Top: n0.getBoundingClientRect().top,
            scrollY: window.scrollY,
            viewH: window.visualViewport?.height ?? window.innerHeight,
          };
        });
        if (!metrics) return Infinity;
        return metrics.scrollY > metrics.viewH * 0.4 &&
          metrics.n0Top < metrics.viewH * 0.4
          ? 0
          : Math.abs(metrics.scrollY - metrics.viewH / 2);
      })
      .toBeLessThan(48);
    expect(metrics!.scrollY).toBeGreaterThan(metrics!.viewH * 0.4);
    expect(metrics!.scrollY).toBeLessThan(metrics!.viewH * 0.6 + 8);
    expect(metrics!.n0Top).toBeLessThan(metrics!.viewH * 0.4);
  });

  test("client zoom with the mode on puts the first child at the list top", async ({
    page,
  }) => {
    const nested: SeedNode[] = [
      { id: "root", parentId: null, prevSiblingId: null, text: "root" },
      ...Array.from({ length: 40 }, (_, i) => ({
        id: `c${i}`,
        parentId: "root",
        prevSiblingId: i === 0 ? null : `c${i - 1}`,
        text: `child${i}`,
      })),
    ];
    await seedOutline(page, nested);
    await page.addInitScript(() => {
      window.localStorage.setItem("dotflowy:spotlight", "true");
    });
    await page.goto("/");
    await expect(text(page, "root")).toBeVisible({ timeout: 15_000 });
    await page.evaluate(() => {
      window.history.pushState({}, "", "/root");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await expect(page.locator("h2.zoomed-title .node-text")).toHaveText("root");
    let metrics: {
      c0Top: number;
      scrollY: number;
      viewH: number;
    } | null = null;
    await expect
      .poll(async () => {
        metrics = await page.evaluate(() => {
          const c0 = document.querySelector('li[data-node-id="c0"]');
          if (!(c0 instanceof HTMLElement)) return null;
          return {
            c0Top: c0.getBoundingClientRect().top,
            scrollY: window.scrollY,
            viewH: window.visualViewport?.height ?? window.innerHeight,
          };
        });
        if (!metrics) return Infinity;
        // Title sits between chrome and the list and scrolls with the well.
        // Pin the well scroll, not a title-relative gap (that gap is pad).
        return metrics.scrollY > metrics.viewH * 0.4 &&
          metrics.c0Top < metrics.viewH * 0.4
          ? 0
          : Math.abs(metrics.scrollY - metrics.viewH / 2);
      })
      .toBeLessThan(48);
    expect(metrics!.scrollY).toBeGreaterThan(metrics!.viewH * 0.4);
    expect(metrics!.scrollY).toBeLessThan(metrics!.viewH * 0.6 + 8);
    expect(metrics!.c0Top).toBeLessThan(metrics!.viewH * 0.4);
  });

  test("focusing a line scrolls it to the vertical center", async ({
    page,
  }) => {
    await loadTall(page, true);
    await text(page, "n0").click();
    await expect(text(page, "n0")).toBeFocused();
    await expect
      .poll(() => offsetFromViewportCenter(page, "n0"))
      .toBeLessThan(48);
  });

  test.describe("chrome click does not yank", () => {
    test.use({
      hasTouch: true,
      isMobile: true,
      viewport: { width: 412, height: 900 },
    });

    test("clicking the mobile action bar does not recenter the still-focused line", async ({
      page,
    }) => {
      await loadTall(page, true);
      await text(page, "n0").click();
      await expect
        .poll(() => offsetFromViewportCenter(page, "n0"))
        .toBeLessThan(48);
      await expect(text(page, "n0")).toBeFocused();
      const undo = page.locator('[data-mobile-bar] [aria-label="Undo"]');
      await expect(undo).toBeVisible();
      await page.evaluate(() => window.scrollBy(0, 250));
      expect(await offsetFromViewportCenter(page, "n0")).toBeGreaterThan(80);
      await undo.click();
      await page.waitForTimeout(280);
      expect(await offsetFromViewportCenter(page, "n0")).toBeGreaterThan(80);
      await expect(text(page, "n0")).toBeFocused();
    });
  });

  test("a short outline does not scrollBy on visualViewport.resize after mount", async ({
    page,
  }) => {
    const short: SeedNode[] = [
      { id: "s0", parentId: null, prevSiblingId: null, text: "short0" },
      { id: "s1", parentId: null, prevSiblingId: "s0", text: "short1" },
      { id: "s2", parentId: null, prevSiblingId: "s1", text: "short2" },
    ];
    await seedOutline(page, short);
    await page.addInitScript(() => {
      window.localStorage.setItem("dotflowy:spotlight", "true");
    });
    await page.goto("/");
    await expect(text(page, "s0")).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(280);
    await page.evaluate(() => {
      const w = window as Window & { __scrollBys?: number };
      w.__scrollBys = 0;
      const orig = window.scrollBy.bind(window);
      window.scrollBy = (...args: Parameters<typeof orig>) => {
        w.__scrollBys = (w.__scrollBys ?? 0) + 1;
        return orig(...args);
      };
    });
    await page.evaluate(() => {
      const vv = window.visualViewport;
      if (!vv) return;
      Object.defineProperty(vv, "height", {
        configurable: true,
        value: (vv.height ?? window.innerHeight) * 0.6,
      });
      vv.dispatchEvent(new Event("resize"));
    });
    await page.waitForTimeout(120);
    const scrollBys = await page.evaluate(() => {
      const w = window as Window & { __scrollBys?: number };
      return w.__scrollBys ?? 0;
    });
    expect(scrollBys).toBe(0);
  });

  test("clicking the already-focused line recenters it", async ({ page }) => {
    await loadTall(page, true);
    await text(page, "n0").click();
    await expect
      .poll(() => offsetFromViewportCenter(page, "n0"))
      .toBeLessThan(48);
    await page.evaluate(() => window.scrollBy(0, 250));
    expect(await offsetFromViewportCenter(page, "n0")).toBeGreaterThan(80);
    await text(page, "n0").click();
    await expect
      .poll(() => offsetFromViewportCenter(page, "n0"))
      .toBeLessThan(48);
  });

  test("arrowing to the next line recenters it", async ({ page }) => {
    await loadTall(page, true);
    await caretOn(page, "n0");
    await expect
      .poll(() => offsetFromViewportCenter(page, "n0"))
      .toBeLessThan(48);
    await page.keyboard.press("ArrowDown");
    await expect(text(page, "n1")).toBeFocused();
    await expect
      .poll(() => offsetFromViewportCenter(page, "n1"))
      .toBeLessThan(48);
  });

  test("with the mode off, focusing does not center the line", async ({
    page,
  }) => {
    await loadTall(page, false);
    await text(page, "n0").click();
    await expect(text(page, "n0")).toBeFocused();
    // n0 stays near the top, far from the vertical center.
    expect(await offsetFromViewportCenter(page, "n0")).toBeGreaterThan(150);
  });
});
