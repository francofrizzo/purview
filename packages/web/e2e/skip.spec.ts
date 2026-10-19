import { test, expect } from "@playwright/test";
import { openPr, openUnit, RECONCILE_HUNKS, UNITS } from "./helpers";

// The fixture's reconciliation unit marks its fourth hunk (…0011, "renamed
// call site") skippable: it shows muted with that label, counts toward
// nothing, and Space passes over it.
const [, , THIRD, SKIPPED, LAST] = RECONCILE_HUNKS;

test("a skippable hunk is muted, labelled, uncounted, and Space passes over it", async ({ page }) => {
  await openPr(page);
  await openUnit(page, UNITS.reconcile);
  // Five hunks, one skippable: the brief says so and the bar is out of four.
  await expect(page.getByTestId("unit-skipped-count")).toHaveText("1 skippable");
  await expect(page.getByTestId("unit-header").getByTestId("hunk-progress")).toContainText("0/4");

  // Step down to it (the pane is virtualized, so it mounts on the way).
  for (let i = 0; i < 3; i++) await page.keyboard.press("j");
  const header = page.getByTestId(`hunk-header-${SKIPPED}`);
  await expect(header).toHaveAttribute("data-focused", "true");
  // Open, not folded: its rows are there, muted.
  await expect(header).toHaveAttribute("data-collapsed", "false");
  await expect(page.getByTestId(`hunk-skip-${SKIPPED}`)).toHaveText("skippable · renamed call site");
  await expect(page.locator('[data-skippable="true"]').first()).toBeVisible();
  await expect(page.getByTestId(`hunk-header-${SKIPPED}`).locator("xpath=..")).not.toHaveAttribute("data-skippable", "true");

  // Space from the hunk before it lands on the one after it.
  await page.keyboard.press("k");
  await expect(page.getByTestId(`hunk-header-${THIRD}`)).toHaveAttribute("data-focused", "true");
  await page.keyboard.press("Space");
  await expect(page.getByTestId(`hunk-header-${LAST}`)).toHaveAttribute("data-focused", "true");
});

test("the files tab leaves skippable hunks out of a file's count", async ({ page }) => {
  await openPr(page);
  await page.getByRole("tab", { name: /files/i }).click();
  await page.getByText("reconcileNightly.ts").first().click();
  await expect(page.getByText("0/1 hunks viewed")).toBeVisible();
});
