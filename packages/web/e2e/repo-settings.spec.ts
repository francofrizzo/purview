import { test, expect } from "@playwright/test";

test("a repo's committed generated-file patterns show under the local lists", async ({ page }) => {
  await page.goto("/repo/git.acme.dev/infra/terraform-modules/settings");
  await expect(page.getByTestId("committed-generated-include")).toContainText("modules/**/README.md");
  await expect(page.getByTestId("committed-generated-exclude")).toContainText(".terraform.lock.hcl");
  // A repo without them shows only its own lists.
  await page.goto("/repo/github.com/acme/billing/settings");
  await expect(page.getByTestId("generated-include")).toBeVisible();
  await expect(page.getByTestId("committed-generated-include")).toHaveCount(0);
});
