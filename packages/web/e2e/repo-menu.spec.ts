import { test, expect } from "@playwright/test";

test("the repo menu is lean, and the merged/closed cleanup sits by the archived list", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("whats-new-close").click().catch(() => {});
  const billing = page.locator("section", { hasText: "acme/billing" }).first();
  await billing.locator('[data-testid^="repo-menu-"]').click();
  // Two actions; import has its own button in the header, and the cleanup sits by the archived list.
  await expect(page.getByRole("menuitem", { name: /import/i })).toHaveCount(0);
  await expect(page.getByTestId(/^repo-archive-/)).toBeVisible();
  await expect(page.getByTestId(/^repo-remove-/)).toBeVisible();
  await expect(page.getByTestId(/^repo-auto-archive-/)).toHaveCount(1);
  await page.keyboard.press("Escape");

  // #474 is merged and #479 is open but already approved by you: the footer
  // offers to sweep both.
  const sweep = billing.getByTestId(/^repo-auto-archive-/);
  await expect(sweep).toContainText("archive 1 merged & 1 reviewed");
  await sweep.click();
  await expect(sweep).toHaveCount(0);
  await expect(billing.getByTestId(/^archived-toggle-/)).toContainText("archived (3)");
});

test("import PRs: its header button looks at once, the searches and span re-look, and only the picked PRs come in", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("whats-new-close").click().catch(() => {});
  await page.getByTestId("import-reviews-toggle-github.com/acme/billing").click();

  // The searches start as the repo's watch settings (billing watches both), and it has looked already.
  await expect(page.getByTestId("import-source-requests")).toBeChecked();
  await expect(page.getByTestId("import-source-own")).toBeChecked();
  await expect(page.getByTestId("import-candidate-505")).toBeVisible();
  // Your PRs alone leave out the one waiting on your review.
  await page.getByTestId("import-source-requests").click();
  await expect(page.getByTestId("import-candidate-505")).toHaveCount(0);
  await expect(page.getByTestId("import-candidate-507")).toBeVisible();
  await page.getByTestId("import-source-requests").click();

  // New ones start ticked; one already on the list is shown, not pickable.
  await expect(page.getByTestId("import-candidate-505")).toContainText("wants your review");
  await expect(page.getByTestId("import-candidate-507")).toContainText("yours");
  await expect(page.getByTestId("import-candidate-482")).toContainText("already on the list");
  await expect(page.getByTestId("import-candidate-482")).not.toHaveAttribute("role", "checkbox");
  await expect(page.getByTestId("import-submit")).toHaveText("import 2");

  // Leave #507 out: the whole row toggles it.
  await page.getByTestId("import-candidate-507").click();
  await expect(page.getByTestId("import-candidate-507")).toHaveAttribute("aria-checked", "false");
  await page.getByTestId("import-submit").click();
  await expect(page.getByTestId("import-result")).toHaveText("imported 1");
  await expect(page.getByTestId("pr-row-github.com/acme/billing/505")).toBeVisible();
  await expect(page.getByTestId("pr-row-github.com/acme/billing/507")).toHaveCount(0);

  // Escape closes it; the add slot and the import slot take turns.
  await page.getByTestId("import-days-14").focus();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("import-form-github.com/acme/billing")).toHaveCount(0);
  await page.getByTestId("import-reviews-toggle-github.com/acme/billing").click();
  await page.getByTestId("repo-add-pr-github.com/acme/billing").click();
  await expect(page.getByTestId("import-form-github.com/acme/billing")).toHaveCount(0);
});
