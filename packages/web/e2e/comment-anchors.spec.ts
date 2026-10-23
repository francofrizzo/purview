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
