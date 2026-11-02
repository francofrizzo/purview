import { expect, test } from "@playwright/test";
import { openPr } from "./helpers";

test("archiving from the PR page goes back home", async ({ page }) => {
  await openPr(page);
  await page.getByTestId("topbar-overflow").click();
  await page.getByTestId("menu-archive").click();
  await expect(page).toHaveURL(/\/$/);
});
