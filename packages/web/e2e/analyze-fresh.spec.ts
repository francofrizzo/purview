import { test, expect } from "@playwright/test";
import { openPr } from "./helpers";

test("the PR menu can analyze from scratch, and the running job takes its place", async ({ page }) => {
  await openPr(page);
  await page.getByTestId("topbar-overflow").click();
  await expect(page.getByTestId("menu-analyze-again")).toBeEnabled();
  const fresh = page.getByTestId("menu-analyze-fresh");
  await expect(fresh).toBeEnabled();
  await fresh.click();
  // The job is live now: the menu offers to cancel instead.
  await page.getByTestId("topbar-overflow").click();
  await expect(page.getByTestId("menu-cancel-analysis")).toBeVisible();
  await expect(page.getByTestId("menu-analyze-fresh")).toHaveCount(0);
  await page.keyboard.press("Escape");
});
