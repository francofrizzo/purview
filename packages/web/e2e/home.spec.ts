import { test, expect, type Page } from "@playwright/test";

/**
 * The home's header field and rows: the field searches the list or, given a
 * PR URL, adds it; tag groups fold and stay folded; compact rows put a PR on
 * one line; tag and archive appear on hover right after the PR's number.
 */
const CHARGE = "github.com/acme/billing/482";
const PLATFORM = "github.com/acme/platform/1190";

async function home(page: Page) {
  await page.goto("/");
  await page.getByTestId("whats-new-close").click().catch(() => {});
  await expect(page.getByTestId(`pr-row-${CHARGE}`)).toBeVisible();
}

test("the field filters the list, says when nothing matches, and Esc brings it all back", async ({ page }) => {
  await home(page);
  const field = page.getByTestId("home-find");
  // "/" from anywhere on the page goes to the field.
  await page.locator("body").press("/");
  await expect(field).toBeFocused();

  await field.fill("#482");
  await expect(page.getByTestId(`pr-row-${CHARGE}`)).toBeVisible();
  await expect(page.getByTestId("pr-row-github.com/acme/billing/491")).toHaveCount(0);
  // A repo with nothing left goes, and so does an emptied block.
  await expect(page.getByTestId(`pr-row-${PLATFORM}`)).toHaveCount(0);
  await expect(page.getByTestId("repo-section-github.com/acme/platform")).toHaveCount(0);
  await expect(page.getByTestId("mine-github.com/acme/billing")).toHaveCount(0);

  // By repo and by author too.
  await field.fill("acme/platform");
  await expect(page.getByTestId(`pr-row-${PLATFORM}`)).toBeVisible();
  await expect(page.getByTestId(`pr-row-${CHARGE}`)).toHaveCount(0);

  await field.fill("no such pull request");
  await expect(page.getByTestId("home-find-empty")).toHaveText('No PR matches "no such pull request". Paste a PR URL to add it.');

  await field.press("Escape");
  await expect(field).toHaveValue("");
  await expect(field).not.toBeFocused();
  await expect(page.getByTestId(`pr-row-${PLATFORM}`)).toBeVisible();
  await expect(page.getByTestId(`pr-row-${CHARGE}`)).toBeVisible();
});

test("a pasted PR URL turns the field's hint into add PR, and Enter adds it", async ({ page }) => {
  await home(page);
  const field = page.getByTestId("home-find");
  await expect(field.locator("xpath=..").locator("kbd")).toHaveText("/");
  await field.fill("https://github.com/acme/billing/pull/9001");
  const add = page.getByTestId("home-add-pr");
  await expect(add).toHaveText("add PR");
  await expect(field.locator("xpath=..").locator("kbd")).toHaveCount(0);
  // A URL is not a search: the list stays whole.
  await expect(page.getByTestId(`pr-row-${PLATFORM}`)).toBeVisible();
  await field.press("Enter");
  await expect(page).toHaveURL(/\/pr\/github\.com\/acme\/billing\/9001$/);
});

test("a tag group folds from its band and stays folded", async ({ page }) => {
  await home(page);
  const block = page.getByTestId("mine-github.com/acme/billing");
  const band = block.getByTestId("pr-tag-heading").filter({ hasText: "payments" });
  const base = page.getByTestId("pr-row-github.com/acme/billing/491");
  await expect(band).toHaveAttribute("aria-expanded", "true");
  await expect(band).toHaveAttribute("data-tip", "Fold the payments PRs");
  await band.click();
  await expect(band).toHaveAttribute("aria-expanded", "false");
  await expect(base).toHaveCount(0);
  // The same tag in another block keeps its own fold.
  await expect(page.getByTestId("needs-review-github.com/acme/billing").getByTestId(`pr-row-${CHARGE}`)).toBeVisible();

  // What's new was closed on the first load; it does not come back.
  await page.reload();
  await expect(band).toHaveAttribute("aria-expanded", "false");
  await expect(base).toHaveCount(0);
  await band.click();
  await expect(base).toBeVisible();
});

test("compact rows put a PR on one line, and the choice is kept", async ({ page }) => {
  await home(page);
  const toggle = page.getByTestId("home-compact");
  const row = page.getByTestId(`pr-row-${CHARGE}`);
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await expect(toggle).toHaveAttribute("data-tip", "Compact rows");
  const tall = (await row.boundingBox())!.height;
  await expect(row.getByTestId("diff-size")).toBeVisible();

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect(toggle).toHaveAttribute("data-tip", "Comfortable rows");
  // The request stays; the rest of the meta line goes.
  await expect(row.getByTestId("review-request-age")).toBeVisible();
  await expect(row.getByTestId("diff-size")).toHaveCount(0);
  await expect.poll(async () => (await row.boundingBox())!.height).toBeLessThan(tall - 15);

  // What's new was closed on the first load; it does not come back.
  await page.reload();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await toggle.click();
  await expect(row.getByTestId("diff-size")).toBeVisible();
});

test("tag and archive show on hover right after the number, and act without opening the PR", async ({ page }) => {
  await home(page);
  const row = page.getByTestId(`pr-row-${CHARGE}`);
  const actions = row.getByTestId("row-actions");
  await page.mouse.move(0, 0);
  await expect(actions).toHaveCSS("opacity", "0");
  await row.hover();
  await expect(actions).toHaveCSS("opacity", "1");

  // On the title's line, after the number.
  const number = row.getByText("#482", { exact: true });
  const n = (await number.boundingBox())!;
  const a = (await actions.boundingBox())!;
  expect(a.x).toBeGreaterThanOrEqual(n.x + n.width);
  expect(Math.abs(a.y + a.height / 2 - (n.y + n.height / 2))).toBeLessThan(4);

  const tag = row.getByTestId(`tag-${CHARGE}`);
  await expect(tag).toHaveAttribute("data-tip", "Tagged payments; change it");
  await tag.click();
  await expect(page.getByTestId("tag-input")).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("tag-input")).toHaveCount(0);

  await row.hover();
  await row.getByTestId(`archive-${CHARGE}`).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByTestId("needs-review-github.com/acme/billing").getByTestId(`pr-row-${CHARGE}`)).toHaveCount(0);
});
