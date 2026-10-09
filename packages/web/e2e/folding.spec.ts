import { test, expect } from "@playwright/test";
import {
  RECONCILE_HUNKS,
  clickAt,
  UNITS,
  expectUnderFileHeader,
  headerTop,
  hunkHeader,
  openPr,
  openUnit,
  scroller,
  settledScrollTop,
  step,
} from "./helpers";

const [A, B, C, , LAST] = RECONCILE_HUNKS;

test.describe("folding keeps the header where the reader sees it", () => {
  test.beforeEach(async ({ page }) => {
    await openPr(page);
    await openUnit(page, UNITS.reconcile);
  });

  test("the chevron folds and unfolds a hunk mid-viewport without moving its header", async ({ page }) => {
    // Park B's header about 300px down the pane: not pinned, not focused.
    await scroller(page).evaluate((sc, id) => {
      const el = document.querySelector(`[data-testid="hunk-header-${id}"]`)!;
      sc.scrollTop += el.getBoundingClientRect().top - sc.getBoundingClientRect().top - 300;
    }, B);
    await settledScrollTop(page);
    const before = await headerTop(page, B);
    expect(before).toBeGreaterThan(250);

    await clickAt(hunkHeader(page, B).getByTestId(`hunk-toggle-${B}`));
    await expect(hunkHeader(page, B)).toHaveAttribute("data-collapsed", "true");
    await settledScrollTop(page);
    expect(Math.abs((await headerTop(page, B)) - before)).toBeLessThanOrEqual(2);

    await clickAt(hunkHeader(page, B).getByTestId(`hunk-toggle-${B}`));
    await expect(hunkHeader(page, B)).toHaveAttribute("data-collapsed", "false");
    await settledScrollTop(page);
    expect(Math.abs((await headerTop(page, B)) - before)).toBeLessThanOrEqual(2);
  });

  test("the viewed checkbox folds a pinned hunk in place", async ({ page }) => {
    await page.keyboard.press("j");
    await expectUnderFileHeader(page, B);
    const before = await headerTop(page, B);

    await clickAt(hunkHeader(page, B).getByRole("button", { name: "Mark as viewed (v)" }));
    await expect(hunkHeader(page, B)).toHaveAttribute("data-collapsed", "true");
    await settledScrollTop(page);
    // A click never scrolls the page away: still focused, still right there.
    expect(Math.abs((await headerTop(page, B)) - before)).toBeLessThanOrEqual(2);
    await expect(hunkHeader(page, B)).toHaveAttribute("data-focused", "true");
  });

  test("the last hunk of a unit can scroll all the way to the top", async ({ page }) => {
    for (const id of RECONCILE_HUNKS.slice(1)) await step(page, "j", id);
    await expectUnderFileHeader(page, LAST);
    await expect(page.locator('[data-sticky="true"] [data-testid="file-header-src/jobs/reconcileNightly.ts"]')).toBeVisible();
    // Nothing further to go to: j stays put.
    await page.keyboard.press("j");
    await expectUnderFileHeader(page, LAST);
  });

  test("a file shown in two units keeps its hidden-lines gaps in both", async ({ page }) => {
    // reconcile.ts: three hunks here, the wiring hunk in another unit.
    await expect(page.getByTestId("gap-src/billing/reconcile.ts:^")).toContainText("3 hidden lines");
    await expect(page.getByTestId(`gap-src/billing/reconcile.ts:${A}`)).toContainText("26 hidden lines");
    await step(page, "j", B);
    await step(page, "j", C);
    await expectUnderFileHeader(page, C);
    await expect(page.getByTestId(`gap-src/billing/reconcile.ts:${C}`)).toContainText("hidden lines");

    // The wiring unit shows only the fourth hunk; the gap above it is keyed by
    // the file's previous hunk (shown in the other unit) and still counts.
    await openUnit(page, UNITS.wiring);
    await expect(page.getByTestId("hunk-header-a1b2c3d4e5f60010")).toBeVisible();
    await expect(page.getByTestId(`gap-src/billing/reconcile.ts:${C}`)).toContainText("28 hidden lines");
    await expect(page.getByTestId("gap-src/billing/reconcile.ts:a1b2c3d4e5f60010")).toContainText("more of the file below");

    // charge.ts: one hunk in each of the two must-read units, the same gap between them in both.
    await openUnit(page, UNITS.charge);
    await expect(page.getByTestId("gap-src/billing/charge.ts:^")).toContainText("17 hidden lines");
    await expect(page.getByTestId("gap-src/billing/charge.ts:a1b2c3d4e5f60001")).toContainText("24 hidden lines");
    await openUnit(page, UNITS.retry);
    await expect(page.getByTestId("gap-src/billing/charge.ts:a1b2c3d4e5f60001")).toContainText("24 hidden lines");
    await expect(page.getByTestId("gap-src/billing/charge.ts:a1b2c3d4e5f60002")).toContainText("more of the file below");
  });
});
