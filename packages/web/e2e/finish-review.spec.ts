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

test("submitting a review says so until GitHub answers", async ({ page }) => {
  await openPr(page);
  await page.getByTestId("topbar-finish-review").click();
  const panel = page.getByTestId("finish-review-panel");
  await panel.getByRole("button", { name: "Comment", exact: true }).click();
  await panel.getByRole("button", { name: /^yes, comment/ }).click();
  // The confirm step stays up with a spinner while the mock takes its time…
  await expect(panel.getByTestId("finish-review-submitting")).toBeVisible();
  // …then the submitted notice replaces it.
  await expect(panel.getByText(/on GitHub/)).toBeVisible();
  await expect(panel.getByTestId("finish-review-submitting")).toHaveCount(0);
});
