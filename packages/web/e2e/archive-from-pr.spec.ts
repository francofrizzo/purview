import { expect, test } from "@playwright/test";
import { openPr } from "./helpers";

test("archiving from the PR page goes back home", async ({ page }) => {
  await openPr(page);
  await page.getByTestId("topbar-overflow").click();
  await page.getByTestId("menu-archive").click();
  await expect(page).toHaveURL(/\/$/);
});

test("the top bar's archive button, and e, archive the PR and go home", async ({ page }) => {
  await openPr(page);
  await expect(page.getByTestId("topbar-archive")).toHaveAttribute("data-tip", "Archive and go home");
  await page.mouse.move(5, 5);
  await page.keyboard.press("e");
  await expect(page).toHaveURL(/\/$/);
  await page.goBack();
  // Archived now: the button gives way to the chip that brings it back.
  await expect(page.getByTestId("topbar-archived")).toBeVisible();
  await expect(page.getByTestId("topbar-archive")).toHaveCount(0);
  await page.getByTestId("topbar-archived").click();
  await page.getByTestId("topbar-archive").click();
  await expect(page).toHaveURL(/\/$/);
});
