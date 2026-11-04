import { test, expect } from "@playwright/test";
import { openComments, openPr } from "./helpers";

test.beforeEach(async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await openPr(page);
  await openComments(page);
});

test("picked-up notes archive in one click, and come back from Archived or go for good", async ({ page }) => {
  const agent = page.getByTestId("drawer-section-agent");
  await expect(agent.getByTestId("comment-card-draft-agent-1")).toBeVisible();
  await page.getByTestId("drawer-archive-picked-up").click();
  await expect(page.getByTestId("comment-card-draft-agent-1")).toHaveCount(0);

  const archived = page.getByTestId("drawer-section-archived");
  await expect(archived).toContainText("Archived1");
  await page.getByTestId("drawer-archived-toggle").click();
  await page.getByTestId("archived-restore-draft-agent-1").click();
  await expect(page.getByTestId("comment-card-draft-agent-1")).toBeVisible();
  await expect(archived).toHaveCount(0);

  // A card archives on its own too; deleting from Archived is final.
  await page.getByTestId("archive-draft-agent-1").click();
  await page.getByTestId("drawer-archived-toggle").click();
  await page.getByTestId("archived-delete-draft-agent-1").click();
  await expect(page.getByTestId("drawer-section-archived")).toHaveCount(0);
  await expect(page.getByTestId("comment-card-draft-agent-1")).toHaveCount(0);
});

test("one copy button: its menu picks copy or copy & archive, and the pick sticks", async ({ page }) => {
  const button = page.getByTestId("copy-bundle-drawer");
  await expect(button).toHaveAttribute("data-mode", "copy");
  await page.getByTestId("copy-bundle-drawer-mode").click();
  await page.getByTestId("copy-bundle-drawer-mode-archive").click();
  // It ran at once: copied, then archived.
  await expect(page.getByTestId("comment-card-draft-agent-1")).toHaveCount(0);
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain("## Review feedback for acme/billing#482");
  await expect(page.getByTestId("drawer-section-archived")).toContainText("1");

  // The mode is remembered: the review panel's copy button opens in it.
  await page.getByTestId("topbar-finish-review").click();
  await expect(page.getByTestId("copy-bundle-review")).toHaveAttribute("data-mode", "archive");
  await expect(page.getByTestId("copy-bundle-review")).toContainText("copy & archive");
});
