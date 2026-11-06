import { test, expect } from "@playwright/test";
import { UNITS, openComposerOnLine, openPr, openUnit } from "./helpers";

test("offline, the app warns once and notes still save; it clears when GitHub answers", async ({ page }) => {
  await openPr(page);
  await page.evaluate(() => localStorage.setItem("reviewer.mockGithubOffline", "1"));
  await page.getByTestId("topbar-refresh").click();
  const offline = page.getByTestId("offline-notice");
  await expect(offline).toContainText("Offline: GitHub can't be reached");
  await expect(offline).toContainText("notes and drafts still save");

  await openUnit(page, UNITS.reconcile);
  await openComposerOnLine(page, 10);
  await page.getByTestId("composer-audience-agent").click();
  await page.getByTestId("composer-textarea").fill("written on a plane");
  await page.getByTestId("composer-save").click();
  await expect(page.getByTestId("comment-composer")).toHaveCount(0);
  await expect(page.getByText("written on a plane")).toBeVisible();

  await page.evaluate(() => localStorage.removeItem("reviewer.mockGithubOffline"));
  await page.getByTestId("error-notice-retry").click();
  await expect(offline).toHaveCount(0);
});

test("the browser losing its network shows the same warning, on the home page too", async ({ page, context }) => {
  await page.goto("/");
  const whatsNew = page.getByTestId("whats-new-close");
  if (await whatsNew.isVisible().catch(() => false)) await whatsNew.click();
  await context.setOffline(true);
  await expect(page.getByTestId("offline-notice")).toBeVisible();
  await context.setOffline(false);
  await expect(page.getByTestId("offline-notice")).toHaveCount(0);
});
