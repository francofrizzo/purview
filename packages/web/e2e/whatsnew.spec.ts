import { test, expect } from "@playwright/test";

test("What's new shows once after an update, and About has the version", async ({ page }) => {
  await page.goto("/");
  const panel = page.getByTestId("whats-new");
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("2026.10.14.1");
  await page.getByTestId("whats-new-close").click();
  await expect(panel).toHaveCount(0);
  // Seen: a reload does not bring it back.
  await page.reload();
  await expect(page.getByText("Waiting on your review").first()).toBeVisible();
  await expect(page.getByTestId("whats-new")).toHaveCount(0);

  await page.goto("/settings");
  const about = page.getByTestId("about-version");
  await about.scrollIntoViewIfNeeded();
  await expect(about).toContainText("Purview 2026.10.14.1");
  await page.getByRole("button", { name: "What's new" }).click();
  await expect(page.getByTestId("whats-new")).toContainText("2026.10.9.1");
});
