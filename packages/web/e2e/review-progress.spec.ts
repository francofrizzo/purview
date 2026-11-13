import { test, expect } from "@playwright/test";
import { UNITS, openPr, openUnit } from "./helpers";

test("the sidebar's bar shows reading by attention; a part opens its next unread unit, and reading fills it", async ({ page }) => {
  await openPr(page);
  await openUnit(page, UNITS.charge);
  const bar = page.getByTestId("review-progress");
  await expect(bar).toBeVisible();
  await expect(page.getByTestId("review-progress-percent")).toHaveText(/^\d+%$/);
  const percent = Number((await page.getByTestId("review-progress-percent").textContent())!.replace("%", ""));

  // The skim part opens the first unread skim unit: the reconciliation.
  const skim = page.getByTestId("review-progress-skim");
  const skimRead = Number(await skim.getAttribute("data-read"));
  await skim.click();
  await expect(page.getByTestId("unit-header")).toContainText(UNITS.reconcile.slice(0, 30));

  // Reading it fills the skim part and moves the percentage.
  await page.mouse.move(5, 5);
  await page.keyboard.press("Shift+KeyV");
  await expect.poll(async () => Number(await skim.getAttribute("data-read"))).toBeGreaterThan(skimRead);
  await expect
    .poll(async () => Number((await page.getByTestId("review-progress-percent").textContent())!.replace("%", "")))
    .toBeGreaterThan(percent);

  // The overview has no bar: nothing there to read through.
  await page.getByTestId("sidebar-tab-overview").click();
  await expect(bar).toHaveCount(0);
});

test("the bar splits by kind instead, and stays that way", async ({ page }) => {
  await openPr(page);
  await openUnit(page, UNITS.charge);
  const bar = page.getByTestId("review-progress");
  await page.getByTestId("review-progress-split-kind").click();
  await expect(bar).toHaveAttribute("data-split", "kind");
  await expect(page.getByTestId("review-progress-must-read")).toHaveCount(0);
  const core = page.getByTestId("review-progress-core-logic");
  await expect(core).toBeVisible();
  await page.reload();
  await expect(page.getByTestId("review-progress")).toHaveAttribute("data-split", "kind");
  await page.getByTestId("review-progress-split-attention").click();
  await expect(page.getByTestId("review-progress-must-read")).toBeVisible();
});
