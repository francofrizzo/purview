import { test, expect } from "@playwright/test";

test("the repo menu is lean, and the merged/closed cleanup sits by the archived list", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("whats-new-close").click().catch(() => {});
  const billing = page.locator("section", { hasText: "acme/billing" }).first();
  await billing.locator('[data-testid^="repo-menu-"]').click();
  // Three actions; the cleanup is not one of them any more.
  await expect(page.getByTestId(/^import-reviews-toggle-/)).toBeVisible();
  await expect(page.getByTestId(/^repo-archive-/)).toBeVisible();
  await expect(page.getByTestId(/^repo-remove-/)).toBeVisible();
  await expect(page.getByTestId(/^repo-auto-archive-/)).toHaveCount(1);
  await page.keyboard.press("Escape");

  // #474 is merged and not archived: the footer offers to sweep it.
  const sweep = billing.getByTestId(/^repo-auto-archive-/);
  await expect(sweep).toContainText("archive 1 merged & closed");
  await sweep.click();
  await expect(sweep).toHaveCount(0);
  await expect(billing.getByTestId(/^archived-toggle-/)).toContainText("archived (2)");
});
