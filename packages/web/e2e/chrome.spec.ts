import { test, expect } from "@playwright/test";
import { UNITS, hunkHeader, openPr, openUnit, scroller } from "./helpers";

test("the view options hold the layout, wrapping, folding, read units and thread filters", async ({ page }) => {
  await openPr(page);
  await expect(page.locator(".diff-half")).toHaveCount(0);
  await page.getByTestId("view-options").click();
  await page.getByTestId("layout-split").click();
  await expect(page.locator(".diff-half").first()).toBeVisible();
  await page.getByTestId("hide-reviewed-units").check();
  await expect(page.getByTestId("hide-reviewed-units")).toBeChecked();
  await page.getByTestId("hide-reviewed-units").uncheck();
  await expect(page.getByTestId("filter-resolved")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("layout-split")).toHaveCount(0);
});

test("the branches open under their icon, each with a copy button", async ({ page }) => {
  await openPr(page);
  await expect(page.getByTestId("topbar-repo")).toContainText("acme/billing#482");
  await page.getByTestId("topbar-branches").hover();
  const panel = page.getByTestId("topbar-branches-panel");
  await expect(panel).toContainText("base");
  await expect(panel).toContainText("dana/charge-retries-idempotency");
  await expect(panel.getByRole("button")).toHaveCount(2);
  // The pointer can reach the copy buttons.
  await panel.getByRole("button").first().hover();
  await expect(panel).toBeVisible();
  await page.getByTestId("topbar-title").hover();
  await expect(panel).toHaveCount(0);
});

test("the shortcuts open as a modal from ? , the ⋯ menu and the sidebar", async ({ page }) => {
  await openPr(page);
  const modal = page.getByTestId("shortcuts-popover");
  await page.keyboard.press("?");
  await expect(modal).toContainText("this list");
  await page.keyboard.press("Escape");
  await expect(modal).toHaveCount(0);
  await page.getByTestId("topbar-overflow").click();
  await page.getByTestId("menu-shortcuts").click();
  await expect(modal).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByTestId("shortcuts-button").click();
  await expect(modal).toBeVisible();
});

test("sync and full screen live in the ⋯ menu; refresh stays and names new commits", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("reviewer.mockStale", "1"));
  await openPr(page);
  const refresh = page.getByTestId("topbar-refresh");
  await expect(refresh).toContainText("new commits");
  await expect(refresh).toHaveAttribute("data-tip", /new commits upstream/);
  await page.getByTestId("topbar-overflow").click();
  await expect(page.getByTestId("menu-sync")).toBeVisible();
});

test("a file says what the PR did to it in a letter, wherever it is listed", async ({ page }) => {
  await openPr(page);
  const badge = (path: string) => page.getByTestId(`file-header-${path}`).first().getByTestId("file-status");
  await expect(badge("src/billing/idempotency.ts")).toHaveText("A");
  await expect(badge("src/billing/charge.ts")).toHaveText("M");
  await page.getByTestId("unit-files-toggle").click();
  await expect(page.getByTestId("unit-files").getByTestId("file-status").first()).toHaveText("A");
});

test("the unit's files open on demand, stay open, and each jumps to its first hunk", async ({ page }) => {
  await openPr(page);
  await expect(page.getByTestId("unit-files")).toHaveCount(0);
  await page.getByTestId("unit-files-toggle").click();
  const files = page.getByTestId("unit-files");
  await files.getByRole("button", { name: /ledger\.ts/ }).click();
  await expect(hunkHeader(page, "a1b2c3d4e5f60005")).toHaveAttribute("data-focused", "true");
  await openUnit(page, UNITS.reconcile);
  await expect(page.getByTestId("unit-files")).toBeVisible();
});

test("past the last hunk the unit offers its next step", async ({ page }) => {
  await openPr(page);
  await openUnit(page, UNITS.reconcile);
  await scroller(page).evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
  await page.getByTestId("unit-end-mark").click();
  await expect(page.getByTestId("unit-header")).not.toContainText(UNITS.reconcile.slice(0, 30));
});

test("the sidebar column resizes by dragging its edge; a double click restores it", async ({ page }) => {
  await openPr(page);
  const handle = page.getByTestId("sidebar-resize");
  const nav = page.locator("nav.pane").first();
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + 2, box.y + 200);
  await page.mouse.down();
  await page.mouse.move(box.x + 82, box.y + 200, { steps: 4 });
  await page.mouse.up();
  await expect.poll(async () => (await nav.boundingBox())!.width).toBeGreaterThan(420);
  await handle.dblclick();
  await expect.poll(async () => Math.round((await nav.boundingBox())!.width)).toBe(352);
});
