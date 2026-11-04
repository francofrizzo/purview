import { test, expect } from "@playwright/test";
import { PR_PATH, openPr } from "./helpers";

test("changed since viewed (rN) marks on the code what changed after rN, in Units and in Files, and clears on a second click", async ({ page }) => {
  await openPr(page);
  const chip = page.getByTestId("changed-since-viewed-a1b2c3d4e5f60001");
  await expect(chip).toContainText("changed since viewed (r2)");
  await chip.click();
  await expect(chip).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator('[data-changed="true"]').first()).toBeVisible();
  await chip.click();
  await expect(chip).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator('[data-changed="true"]')).toHaveCount(0);

  // The files tab marks it too.
  await page.goto(`${PR_PATH}?view=files&file=${encodeURIComponent("src/billing/charge.ts")}`);
  const inFiles = page.getByTestId("changed-since-viewed-a1b2c3d4e5f60001");
  await inFiles.click();
  await expect(page.locator('[data-changed="true"]').first()).toBeVisible();
});
