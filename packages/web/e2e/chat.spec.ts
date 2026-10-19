import { expect, test } from "@playwright/test";
import { openPr } from "./helpers";

test.beforeEach(async ({ page }) => {
  await openPr(page);
  await page.keyboard.press("m");
  await page.getByTestId("dock-tab-chat").click();
  await expect(page.getByTestId("chat-panel")).toBeVisible();
});

test("stopping a reply says so until the turn winds down", async ({ page }) => {
  await page.getByTestId("chat-input").fill("What is the riskiest change?");
  await page.getByTestId("chat-send").click();

  const stop = page.getByTestId("chat-stop");
  await expect(stop).toBeVisible();
  await stop.click();
  // The mock's stop takes a moment to land, like the real child exiting.
  await expect(stop).toHaveText(/stopping…/);
  await expect(stop).toBeDisabled();

  await expect(page.getByTestId("chat-stopped")).toBeVisible();
  await expect(page.getByTestId("chat-stop")).toHaveCount(0);
  await expect(page.getByTestId("chat-error")).toHaveCount(0);
});
