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

test("a clear or rewind that fails says so and leaves the transcript alone", async ({ page }) => {
  // "keep" makes the mock refuse to clear or rewind this transcript.
  await page.getByTestId("chat-input").fill("keep this one");
  await page.getByTestId("chat-send").click();
  await expect(page.getByTestId("chat-stop")).toBeVisible();
  await page.getByTestId("chat-stop").click();
  await expect(page.getByTestId("chat-stopped")).toBeVisible();

  await page.getByTestId("chat-rewind-0").click({ force: true });
  await page.getByTestId("chat-rewind-confirm-0").click();
  const error = page.getByTestId("chat-error");
  await expect(error).toContainText("The rewind did not go through");
  await expect(error).toContainText("mock failure");
  await expect(page.getByTestId("chat-panel")).toContainText("keep this one");
  await page.getByTestId("chat-dismiss-failure").click();
  await expect(error).toHaveCount(0);

  await page.getByTestId("chat-menu").click();
  await page.getByTestId("chat-clear").click();
  await page.getByTestId("chat-clear-confirm").click();
  await expect(error).toContainText("The conversation was not cleared");
  await expect(page.getByTestId("chat-panel")).toContainText("keep this one");
});
