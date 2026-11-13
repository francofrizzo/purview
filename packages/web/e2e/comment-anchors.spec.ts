import { test, expect } from "@playwright/test";
import { openPr, openComments } from "./helpers";

test("outdated draft shows its original revision and line", async ({ page }) => {
  await openPr(page);
  await openComments(page);
  const chip = page.getByTestId("comment-card-draft-agent-1").getByTestId("comment-outdated").last();
  await expect(chip).toBeVisible();
  await expect(chip).toHaveText("outdated");
  await expect(chip).toHaveAttribute("data-tip", "Written on rev 1 at line 24; that line is no longer in the diff");
});

test("an outdated draft clicked in the files tab opens its file with the file's comments shown", async ({ page }) => {
  await openPr(page);
  await page.getByTestId("sidebar-tab-files").click();
  await openComments(page);
  await page
    .getByTestId("comments-panel")
    .getByTestId("comment-card-draft-agent-1")
    .getByRole("button", { name: /charge\.ts/ })
    .click();
  // Not at line 24 of today's diff, which is other code: in the file's block.
  await expect(page.getByTestId("comment-card-draft-agent-1")).toHaveCount(2);
  await expect(page.locator("[data-diff-scroller]").getByTestId("comment-card-draft-agent-1")).toHaveCount(0);
});
