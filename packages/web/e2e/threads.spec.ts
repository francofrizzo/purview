import { test, expect } from "@playwright/test";
import { openPr } from "./helpers";

test.beforeEach(async ({ page }) => {
  await openPr(page);
});

test("the comment drawer opens and lists the drafts by stage", async ({ page }) => {
  await page.getByTestId("topbar-comments").click();
  const drafts = page.getByTestId("drawer-group-drafts");
  await expect(drafts).toBeVisible();
  await expect(drafts).toContainText("Drafts");
  await expect(drafts.getByTestId("comment-card-draft-1")).toContainText("Should the ledger write happen before the gateway call");
  await expect(drafts.getByTestId("comment-card-draft-10")).toContainText("Recording the failure and then throwing");
  await expect(page.getByTestId("drawer-group-pushed").getByTestId("comment-card-draft-2")).toBeVisible();
  await expect(page.getByTestId("drawer-group-submitted").getByTestId("comment-card-draft-4")).toBeVisible();
  await expect(page.getByTestId("drawer-group-github")).toBeVisible();

  await page.getByTestId("topbar-comments").click();
  await expect(drafts).toHaveCount(0);
});

test("the finish-review panel shows the drafts going out and what is on GitHub so far", async ({ page }) => {
  await page.getByTestId("topbar-finish-review").click();
  const panel = page.locator("aside", { hasText: "Finish review" });
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId("review-readiness")).toBeVisible();

  const github = panel.getByTestId("previous-reviews");
  await expect(github).toContainText("On GitHub so far");
  await expect(github).toContainText("maria");
  await expect(github).toContainText(/unresolved threads/);

  await expect(panel.getByText("Comments", { exact: true })).toBeVisible();
  await expect(panel.getByTestId("comment-card-draft-1")).toBeVisible();
  await expect(panel.getByTestId("comment-card-draft-11")).toContainText("Stamp the row");

  await panel.getByRole("button", { name: "Close" }).click();
  await expect(panel).toHaveCount(0);
});
