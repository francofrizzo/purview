import { test, expect, type Page } from "@playwright/test";
import { MOD, RECONCILE_HUNKS, UNITS, openComposerOnLine, openPr, openUnit, scroller, step } from "./helpers";

/**
 * Saving a comment must not move what the reader is looking at. The composer
 * is a virtual row: when the reader has scrolled it (and its line) above the
 * pane's top edge while writing, closing it used to shift everything under
 * their eye by the composer's height.
 */

/** The first diff row fully under the pane's top edge: its text and where it sits. */
async function rowAtTop(page: Page): Promise<{ text: string; top: number }> {
  return page.evaluate(() => {
    const sc = document.querySelector("[data-diff-scroller]")!;
    const r = sc.getBoundingClientRect();
    const row = [...sc.querySelectorAll(".diff-line")].find((el) => {
      const b = el.getBoundingClientRect();
      return b.top >= r.top + 60 && b.bottom <= r.bottom;
    })!;
    return { text: row.textContent!, top: Math.round(row.getBoundingClientRect().top - r.top) };
  });
}

/** Where a row with that text sits now, relative to the pane's top edge (NaN when gone). */
async function rowTop(page: Page, text: string): Promise<number> {
  return page.evaluate((t) => {
    const sc = document.querySelector("[data-diff-scroller]")!;
    const row = [...sc.querySelectorAll(".diff-line")].find((el) => el.textContent === t);
    return row ? Math.round(row.getBoundingClientRect().top - sc.getBoundingClientRect().top) : Number.NaN;
  }, text);
}

async function composerTop(page: Page): Promise<number> {
  return page.evaluate(() => {
    const sc = document.querySelector("[data-diff-scroller]")!;
    const c = document.querySelector('[data-testid="comment-composer"]')!;
    return c.getBoundingClientRect().top - sc.getBoundingClientRect().top;
  });
}

/** Write a long comment, then scroll on so the composer's top edge ends `pastEdge` px above the pane's (negative: below). */
async function writeThenScroll(page: Page, pastEdge: number) {
  await openPr(page);
  await openUnit(page, UNITS.reconcile);
  for (const id of RECONCILE_HUNKS.slice(1, 4)) await step(page, "j", id);
  await openComposerOnLine(page, 6);
  await page
    .getByTestId("composer-textarea")
    .fill(Array.from({ length: 12 }, (_, i) => `paragraph ${i} of a comment long enough to grow the box`).join("\n"));
  await page.waitForTimeout(200);
  const by = (await composerTop(page)) + pastEdge;
  await scroller(page).evaluate((el, dy) => {
    el.scrollTop += dy;
  }, by);
  await page.waitForTimeout(200);
}

async function saveAndSettle(page: Page) {
  await page.getByTestId("composer-textarea").focus();
  await page.keyboard.press(`${MOD}+Enter`);
  await expect(page.getByTestId("comment-composer")).toHaveCount(0);
  // The saved comment lands as an open card under its line.
  await expect(scroller(page).locator("[data-testid^=inline-comment-]").first()).toBeAttached();
  await page.waitForTimeout(400);
}

test("saving with the composer scrolled above the pane keeps the row under the top edge in place", async ({ page }) => {
  await writeThenScroll(page, 40);
  expect(await composerTop(page)).toBeLessThan(0);
  const before = await rowAtTop(page);

  await saveAndSettle(page);

  const after = await rowTop(page, before.text);
  expect(Math.abs(after - before.top), `row "${before.text.slice(0, 40)}" was at ${before.top}, now at ${after}`).toBeLessThanOrEqual(3);
  // The keyboard did not fall to <body>: j/k and n keep working from here.
  expect(await page.evaluate(() => Boolean(document.activeElement?.closest("[data-diff-scroller]")))).toBe(true);
});

test("saving with the composer still in view changes nothing above it", async ({ page }) => {
  await writeThenScroll(page, -120);
  expect(await composerTop(page)).toBeGreaterThan(0);
  const before = await rowAtTop(page);

  await saveAndSettle(page);

  expect(Math.abs((await rowTop(page, before.text)) - before.top)).toBeLessThanOrEqual(3);
});
