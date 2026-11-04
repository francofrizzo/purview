import { test, expect } from "@playwright/test";
import { openPr } from "./helpers";

test("a refresh the server never answered says so, that it may have finished, and offers to try again", async ({ page }) => {
  await openPr(page);
  await page.evaluate(() => localStorage.setItem("reviewer.mockOffline", "1"));
  await page.getByTestId("topbar-refresh").click();
  const notice = page.getByTestId("error-notice");
  await expect(notice).toContainText("Refresh failed");
  await expect(notice).toContainText("Purview's server did not answer");
  await expect(notice).toContainText("may have finished anyway");
  await expect(notice).not.toContainText("Failed to fetch");

  await page.evaluate(() => localStorage.removeItem("reviewer.mockOffline"));
  await page.getByTestId("error-notice-retry").click();
  await expect(notice).toHaveCount(0);
  await expect(page.getByTestId("error-notice")).toHaveCount(0, { timeout: 5_000 });
});
