import { test, expect } from "@playwright/test";
import { openPr, openUnit, RECONCILE_HUNKS, UNITS } from "./helpers";

// The fixture's reconciliation unit folds its fourth hunk (…0011, "renamed
// call site"): it starts shut with that label, counts toward nothing, and
// Space passes over it.
const [, , THIRD, FOLDED] = RECONCILE_HUNKS;

test("an analysis-folded hunk starts shut, labelled, uncounted, and Space passes over it", async ({ page }) => {
  await openPr(page);
  await openUnit(page, UNITS.reconcile);
  // Five hunks, one folded: the brief says so and the bar is out of four.
  await expect(page.getByTestId("unit-folded-count")).toHaveText("1 folded");
  await expect(page.getByTestId("unit-header").getByTestId("hunk-progress")).toContainText("0/4");

  // Step down to it (the pane is virtualized, so it mounts on the way).
  for (let i = 0; i < 3; i++) await page.keyboard.press("j");
  const header = page.getByTestId(`hunk-header-${FOLDED}`);
  await expect(header).toHaveAttribute("data-focused", "true");
  await expect(header).toHaveAttribute("data-collapsed", "true");
  await expect(page.getByTestId(`hunk-fold-${FOLDED}`)).toHaveText("renamed call site");

  // Space from the hunk before it skips to the next unread one after it.
  await page.keyboard.press("k");
  await expect(page.getByTestId(`hunk-header-${THIRD}`)).toHaveAttribute("data-focused", "true");
  await page.keyboard.press("Space");
  await expect(page.getByTestId(`hunk-header-${RECONCILE_HUNKS[4]}`)).toHaveAttribute("data-focused", "true");

  // It is still there to read: the toggle opens it like any other hunk.
  await page.getByTestId(`hunk-toggle-${FOLDED}`).click();
  await expect(header).toHaveAttribute("data-collapsed", "false");
});

test("the files tab leaves folded hunks out of a file's count", async ({ page }) => {
  await openPr(page);
  await page.getByRole("tab", { name: /files/i }).click();
  await page.getByText("reconcileNightly.ts").first().click();
  await expect(page.getByText("0/1 hunks viewed")).toBeVisible();
});
