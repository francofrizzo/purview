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
  // Newest first, each summary right under its revision's button.
  const rows = page.locator("[data-testid^=revision-row-]");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText("r3");
  await expect(rows.nth(0).getByTestId("highlight-revision-3")).toBeVisible();
  const button = await rows.nth(0).getByTestId("highlight-revision-3").boundingBox();
  const line = await r3.boundingBox();
  expect(line!.y).toBeGreaterThan(button!.y + button!.height - 1);
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
