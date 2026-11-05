import { test, expect } from "@playwright/test";
import { openPr } from "./helpers";

/**
 * The per-revision summary (fixture: r2 and r3 carry one, r1 never does):
 * one muted line under each revision in the rev menu, and the "since review"
 * chip's tip says what landed since, newest first.
 */
test("the rev menu shows what each revision changed, under its row", async ({ page }) => {
  await openPr(page);
  await page.getByTestId("revision-menu").click();
  const r3 = page.getByTestId("revision-summary-3");
  await expect(r3).toHaveText("Charges are keyed by (orderId, amount, currency) and a nightly reconciliation replaces the retention job.");
  await expect(r3).toHaveAttribute("aria-label", /^r3 · Charges are keyed/);
  await expect(page.getByTestId("revision-summary-2")).toContainText("retry wrapper gained jitter");
  await expect(page.getByTestId("revision-summary-1")).toHaveCount(0);
  // Newest first, each summary part of its revision's row, the row the toggle.
  const rows = page.locator("[data-testid^=revision-row-]");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText("r3");
  await expect(rows.nth(0).getByTestId("highlight-revision-3").getByTestId("revision-summary-3")).toBeVisible();
  // A revision moved to new commits with the same diff says so (fixture: r3, twice).
  await expect(page.getByTestId("revision-advances-3")).toContainText("Pushed again 2× with the same diff");
  await expect(page.getByTestId("revision-advances-2")).toHaveCount(0);
  // The first revision is on the timeline too, with nothing to light up.
  await expect(page.getByTestId("revision-first")).toContainText("r1");
  await expect(page.getByTestId("highlight-revision-1")).toHaveCount(0);
});

test("the since-review chip's tip lists the revisions that landed since, newest first", async ({ page }) => {
  await openPr(page);
  const chip = page.getByTestId("since-review-toggle");
  await expect(chip).toHaveAttribute(
    "data-tip",
    /Since then: r3 · Charges are keyed by \(orderId, amount, currency\)/,
  );
  // r2 is the reviewed revision itself: not "since then".
  await expect(chip).not.toHaveAttribute("data-tip", /r2 · /);
  await chip.hover();
  await expect(page.locator(".tip")).toContainText("Since then: r3 · Charges are keyed");
});
