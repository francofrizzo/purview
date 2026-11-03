import { expect, test } from "@playwright/test";
import { openPr } from "./helpers";

test("a PR with no analysis shows its state as a card at the top of the sidebar", async ({ page }) => {
  await page.goto("/pr/github.com/acme/billing/502");
  const card = page.locator("nav").getByTestId("analysis-banner");
  await expect(card).toContainText("Not analyzed yet");
  await expect(card).not.toHaveAttribute("data-compact", "true");
  await card.getByTestId("analysis-start").click();
  await expect(card).toContainText(/Analysis queued|Analyzing/);
  await expect(card.getByTestId("analysis-cancel")).toBeVisible();
});

test("re-analyzing a PR with units is one line above the units, with cancel", async ({ page }) => {
  await openPr(page);
  await page.getByTestId("topbar-overflow").click();
  await page.getByTestId("menu-analyze-again").click();
  const line = page.locator("nav").getByTestId("analysis-banner");
  await expect(line).toHaveAttribute("data-compact", "true");
  await expect(line).toContainText("Analyzing");
  await line.getByTestId("analysis-cancel").click();
  await expect(line).toHaveCount(0);
});

test("an action's result is a toast that can be closed; a confirm is a dialog", async ({ page }) => {
  await openPr(page);
  await page.getByTestId("topbar-overflow").click();
  await page.getByTestId("menu-sync").click();
  const toast = page.getByTestId("sync-notice");
  await expect(toast).toContainText("Synced to GitHub");
  await toast.getByRole("button", { name: "Dismiss" }).click();
  await expect(toast).toHaveCount(0);

  await page.getByTestId("topbar-overflow").click();
  await page.getByTestId("menu-share-analysis-to-pr").click();
  const dialog = page.getByTestId("share-analysis-confirm-dialog");
  await expect(dialog).toContainText("Share the analysis on this PR?");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
});
