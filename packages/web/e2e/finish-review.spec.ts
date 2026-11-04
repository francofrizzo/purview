import { expect, test } from "@playwright/test";
import { openPr, ui } from "./helpers";

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
  await expect(ui(panel, /on GitHub/)).toBeVisible();
  await expect(progress).toHaveCount(0);
  await expect(page.getByTestId("topbar-review-sending")).toHaveCount(0);
});

test("from the summary, Ctrl+1, 2, 3 pick the verdict and Cmd+Enter submits it", async ({ page }) => {
  await openPr(page);
  await page.getByTestId("topbar-finish-review").click();
  const panel = page.getByTestId("finish-review-panel");
  const summary = panel.getByPlaceholder("What should the author take away? (optional)");
  await summary.fill("Ship it once the ledger write is ordered.");
  await summary.press("Control+2");
  await expect(panel.getByTestId("verdict-approve")).toHaveAttribute("aria-checked", "true");
  await summary.press("Control+3");
  await expect(panel.getByTestId("verdict-request_changes")).toHaveAttribute("aria-checked", "true");
  await expect(summary).toHaveValue("Ship it once the ledger write is ordered.");
  await summary.press("Control+2");
  // Must-read units are still unread in the fixture: the same confirm as the button.
  await summary.press("ControlOrMeta+Enter");
  await expect(panel.getByRole("button", { name: /^yes, approve/ })).toBeVisible();
});
