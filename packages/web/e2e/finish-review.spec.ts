import { expect, test } from "@playwright/test";
import { openPr } from "./helpers";

test("the summary says \"saved\" when a blur puts it on disk, and only after an edit", async ({ page }) => {
  await openPr(page);
  await page.getByTestId("topbar-finish-review").click();
  const panel = page.getByTestId("finish-review-panel");
  const summary = panel.getByPlaceholder("What should the author take away? (optional)");
  await expect(summary).toBeVisible();

  // No edit: a blur saves nothing and says nothing.
  await summary.focus();
  await summary.blur();
  await expect(panel.getByTestId("saved-flash")).toHaveCount(0);

  await summary.fill("Looks good once the ledger write is ordered.");
  await summary.blur();
  await expect(panel.getByTestId("saved-flash")).toHaveText(/saved/);
  await expect(panel.getByTestId("saved-flash")).toHaveCount(0, { timeout: 5_000 });
});

test("submitting a review shows each step until the page has settled, then says what was sent", async ({ page }) => {
  await openPr(page);
  await page.getByTestId("topbar-finish-review").click();
  const panel = page.getByTestId("finish-review-panel");
  await panel.getByTestId("verdict-comment").click();
  // Must-read units are still unread in the fixture, so submit asks first.
  await panel.getByTestId("submit-review").click();
  await panel.getByRole("button", { name: /^yes, comment/ }).click();
  // The checklist takes the decision's place, one step at a time…
  const progress = panel.getByTestId("submit-progress");
  await expect(progress).toBeVisible();
  await expect(page.getByTestId("topbar-review-sending")).toBeVisible();
  await expect(progress.locator('[data-step="post"]')).toHaveAttribute("data-state", "now");
  await expect(progress.locator('[data-step="submit"]')).toHaveAttribute("data-state", "done");
  // …and only when it is gone does the panel say what was sent.
  await expect(panel.getByText(/on GitHub/)).toBeVisible();
  await expect(progress).toHaveCount(0);
  await expect(page.getByTestId("topbar-review-sending")).toHaveCount(0);
});
