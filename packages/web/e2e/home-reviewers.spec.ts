import { test, expect } from "@playwright/test";

const YOURS_DRAFT = "github.com/acme/billing/491";
const YOURS_OPEN = "github.com/acme/billing/502";
const NOT_YOURS = "github.com/acme/billing/482";

test("your PRs show who is on them, or that nobody is; other PRs show nothing", async ({ page }) => {
  await page.goto("/");
  const draft = page.getByTestId(`pr-row-${YOURS_DRAFT}`);
  await expect(draft.getByTestId("no-reviewers")).toBeVisible();
  await expect(draft.getByTestId("reviewers")).toHaveCount(0);

  const open = page.getByTestId(`pr-row-${YOURS_OPEN}`);
  const cluster = open.getByTestId("reviewers");
  await expect(cluster).toBeVisible();
  const avatars = cluster.getByTestId("reviewer");
  await expect(avatars).toHaveCount(3);
  await expect(avatars.nth(0)).toHaveAttribute("data-state", "requested");
  await expect(avatars.nth(1)).toHaveAttribute("data-state", "approved");
  await expect(avatars.nth(2)).toHaveAttribute("data-state", "changes_requested");
  await expect(cluster).toHaveAttribute("data-tip", "dana · requested\nsam · approved\nlee · changes requested");

  const theirs = page.getByTestId(`pr-row-${NOT_YOURS}`);
  await expect(theirs).toBeVisible();
  await expect(theirs.getByTestId("reviewers")).toHaveCount(0);
  await expect(theirs.getByTestId("no-reviewers")).toHaveCount(0);
});

test("a PR with new commits upstream carries an update button that refreshes it from the list", async ({ page }) => {
  await page.goto("/");
  // The What's new dialog of a first visit sits over the list.
  await page.getByTestId("whats-new-close").click();
  const row = page.getByTestId(`pr-row-${YOURS_DRAFT}`);
  // The status cluster is rendered twice (phone and wide layouts); only one is shown.
  const button = row.getByTestId("update-button").locator("visible=true");
  await expect(button).toHaveAttribute("data-tip", "New commits on GitHub · refresh this PR");
  await expect(page.getByTestId(`pr-row-github.com/acme/billing/502`).getByTestId("update-button")).toHaveCount(0);
  await button.click();
  // The click stays on the list.
  await expect(page).toHaveURL(/\/$/);
  await expect(row.getByTestId("update-button")).toHaveCount(0);
  await expect(row).toBeVisible();
});

test("the PR page of one of yours shows the reviewers in the header", async ({ page }) => {
  await page.goto(`/pr/${YOURS_OPEN}`);
  const cluster = page.getByTestId("topbar-meta").getByTestId("reviewers");
  await expect(cluster).toBeVisible();
  await expect(cluster.getByTestId("reviewer")).toHaveCount(3);
  await page.goto(`/pr/${NOT_YOURS}`);
  await expect(page.getByTestId("topbar-meta")).toBeVisible();
  await expect(page.getByTestId("topbar-meta").getByTestId("reviewers")).toHaveCount(0);
});
