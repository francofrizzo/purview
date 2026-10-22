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
  const panel = page.getByTestId("finish-review-panel");
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId("review-readiness")).toBeVisible();

  const github = panel.getByTestId("previous-reviews");
  await expect(github).toContainText("On GitHub so far");
  await expect(github).toContainText(/unresolved threads/);
  // Each verdict carries what the review said and leads to its inline comments.
  const maria = github.getByTestId("verdict-row-maria");
  await expect(maria).toContainText("requested changes");
  await expect(maria.getByTestId("review-body")).toContainText("The retry wrapper swallows the gateway's 4xx");
  await maria.getByTestId("verdict-inline-jump").click();
  await expect(page.locator('[data-testid^="hunk-header-"][data-focused="true"]')).toBeVisible();

  await expect(panel.getByText("Comments", { exact: true })).toBeVisible();
  await expect(panel.getByTestId("comment-card-draft-1")).toBeVisible();
  await expect(panel.getByTestId("comment-card-draft-11")).toContainText("Stamp the row");

  await page.getByTestId("dock-close").click();
  await expect(panel).toHaveCount(0);
});

test("a GitHub thread in the drawer can be copied with its code, replied to and resolved from there", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.getByTestId("topbar-comments").click();
  const row = page.getByTestId("drawer-thread-PRRT_charge77_79");
  await expect(row).toBeVisible();
  await row.hover();

  await page.getByTestId("drawer-thread-copy-PRRT_charge77_79").click();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toContain("### `src/billing/charge.ts:77–79` (new side)");
  expect(copied).toContain("```typescript");
  expect(copied).toContain("> **maria**:");
  expect(copied).toContain("> **dana**:");
  expect(copied).toContain("Cap the backoff");

  await row.hover();
  await page.getByTestId("drawer-thread-resolve-PRRT_charge77_79").click();
  await expect(page.getByTestId("drawer-thread-resolve-PRRT_charge77_79")).toBeDisabled();
  await expect(row.locator('[aria-label="resolved"]')).toBeVisible();
  await expect(page.getByTestId("drawer-thread-resolve-PRRT_charge77_79")).toHaveAttribute("data-tip", "Mark unresolved on GitHub");

  await row.hover();
  await page.getByTestId("drawer-thread-reply-PRRT_charge77_79").click();
  const composer = page.getByTestId("comment-composer");
  await expect(composer).toBeVisible();
  await expect(composer).toContainText("maria");
});


test("a root comment reaction can be added and removed from the drawer", async ({ page }) => {
  await page.getByTestId("topbar-comments").click();
  const row = page.getByTestId("drawer-thread-PRRT_charge77_79");
  const actions = page.getByTestId("drawer-thread-actions-PRRT_charge77_79");
  await expect(row.getByTestId("reaction-THUMBS_UP")).toContainText("👍2");
  await expect(row.getByTestId("reaction-EYES")).toHaveAttribute("data-mine", "true");
  await row.hover();
  await actions.getByRole("button", { name: "Add a reaction on GitHub" }).click();
  await page.getByTestId("react-pick-HOORAY").click();
  await expect(row.getByTestId("reaction-HOORAY")).toHaveAttribute("data-mine", "true");
  await row.hover();
  await actions.getByRole("button", { name: "Add a reaction on GitHub" }).click();
  await page.getByTestId("react-pick-HOORAY").click();
  await expect(row.getByTestId("reaction-HOORAY")).toHaveCount(0);
});
