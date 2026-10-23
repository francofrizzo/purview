import { test, expect, type Locator } from "@playwright/test";

/**
 * The two Watch switches save on their own. The checkboxes are controlled
 * and only flip once the save lands, so each toggle clicks and then waits
 * for the state rather than using Playwright's check/uncheck.
 */
async function toggle(box: Locator, checked: boolean) {
  await box.click();
  await expect(box).toBeEnabled();
  if (checked) await expect(box).toBeChecked();
  else await expect(box).not.toBeChecked();
}

test("watch switches save independently", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("whats-new-close").click().catch(() => {});
  const settings = page.getByTestId("repo-settings-github.com/acme/billing");
  await settings.click();
  const reviews = page.getByTestId("watch-reviews-checkbox");
  const own = page.getByTestId("watch-own-checkbox");
  await expect(reviews).toBeChecked();
  await expect(own).toBeChecked();

  await toggle(reviews, false);
  await toggle(own, false);
  await toggle(own, true);
  await expect(reviews).not.toBeChecked();

  // Closing and reopening keeps the mock's state; the home dot names what is polled.
  await page.getByTestId("modal-close").click();
  const billing = page.locator("section", { hasText: "acme/billing" }).first();
  await expect(billing.getByText("watching", { exact: true })).toHaveAttribute("data-tip", /Polling for your PRs;/);
  await settings.click();
  await expect(own).toBeChecked();
  await expect(reviews).not.toBeChecked();

  await toggle(reviews, true);
  await toggle(own, false);
  await page.getByTestId("modal-close").click();
  await expect(billing.getByText("watching", { exact: true })).toHaveAttribute("data-tip", /Polling for review requests;/);
  await settings.click();
  await expect(reviews).toBeChecked();
  await expect(own).not.toBeChecked();
});
