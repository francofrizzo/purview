import { test, expect } from "@playwright/test";

test("a newer release on origin shows an update chip, with the command; the check can be turned off", async ({ page }) => {
  await page.goto("/");
  // "What's new" floats over the list on a fresh session; dismiss it first.
  await expect(page.getByTestId("whats-new")).toBeVisible();
  await page.getByTestId("whats-new-close").click();
  await expect(page.getByTestId("whats-new")).toHaveCount(0);

  const chip = page.getByTestId("update-available");
  await expect(chip).toBeVisible();
  await expect(chip).toHaveText("Update available");
  await chip.click();
  const card = page.getByTestId("update-card");
  await expect(card).toContainText("Purview 2026.10.15.1 is available");
  await expect(card).toContainText("git pull && pnpm start");
  await page.keyboard.press("Escape");
  await expect(card).toHaveCount(0);

  // Inside a PR the same chip is the icon with a dot, named on hover.
  await page.getByText("Charge retries: idempotency keys + backoff").click();
  await expect(page.getByTestId("topbar-comments")).toBeVisible();
  const compact = page.getByTestId("update-available");
  await expect(compact).toHaveAttribute("data-tip", "Purview 2026.10.15.1 is available");
  await expect(compact).not.toContainText("available");
  await page.goBack();
  await expect(page.getByText("Waiting on your review").first()).toBeVisible();

  // Open settings from the header so the app (and the mock's in-memory config) stays alive.
  await page.getByRole("link", { name: "settings", exact: true }).click();
  const toggle = page.getByTestId("global-update-check");
  await toggle.scrollIntoViewIfNeeded();
  await expect(page.getByTestId("about-update")).toContainText("2026.10.15.1 is available");
  await page.getByTestId("about-check-now").click();
  await expect(page.getByTestId("about-check-now")).toHaveText("Check now");
  await expect(page.getByTestId("about-update")).toContainText("2026.10.15.1 is available");
  await toggle.click();
  await expect(toggle).not.toBeChecked();
  await expect(page.getByTestId("about-update")).toHaveCount(0);

  await page.keyboard.press("Escape");
  await expect(page.getByText("Waiting on your review").first()).toBeVisible();
  await expect(page.getByTestId("update-available")).toHaveCount(0);
});
