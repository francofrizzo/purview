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

test("a click on the title splits the bar by kind of change instead, and it stays that way", async ({ page }) => {
  await openPr(page);
  await openUnit(page, UNITS.charge);
  const bar = page.getByTestId("review-progress");
  const title = page.getByTestId("review-progress-split");
  await expect(title).toHaveText(/^Review progress\s*by attention$/);
  await title.click();
  await expect(bar).toHaveAttribute("data-split", "kind");
  await expect(title).toHaveText(/^Review progress\s*by kind$/);
  await expect(page.getByTestId("review-progress-must-read")).toHaveCount(0);
  await expect(page.getByTestId("review-progress-implementation")).toBeVisible();
  // Generated is never owed: however many its lines, it takes little of the bar.
  const generated = page.getByTestId("review-progress-generated");
  if (await generated.count()) {
    const [part, whole] = await Promise.all([generated.boundingBox(), bar.boundingBox()]);
    expect(part!.width).toBeLessThanOrEqual(whole!.width * 0.13);
  }
  await page.reload();
  await expect(page.getByTestId("review-progress")).toHaveAttribute("data-split", "kind");
  await page.getByTestId("review-progress-split").click();
  await expect(page.getByTestId("review-progress-must-read")).toBeVisible();
});
