import { test, expect } from "@playwright/test";
import { UNITS, openPr } from "./helpers";

test("the overview's behavior changes show without an experiment; a row opens the unit that makes it", async ({ page }) => {
  await openPr(page);
  await page.getByTestId("sidebar-tab-overview").click();
  const table = page.getByTestId("overview-behavior");
  await expect(table).toBeVisible();
  await expect(table.getByTestId("behavior-change")).toHaveCount(5);
  // The unit column is headed by the Guide tab's icon.
  await expect(table.getByTestId("behavior-unit-head").locator("svg")).toBeVisible();

  await table.getByTestId("behavior-change").filter({ hasText: "Client retries a charge" }).getByRole("button").click();
  await expect(page.getByTestId("unit-header")).toContainText(UNITS.charge.slice(0, 30));
});

test("an analysis that found no behavior changes says so, which reads as a refactor", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("reviewer.mockNoBehavior", "1"));
  await openPr(page);
  await page.getByTestId("sidebar-tab-overview").click();
  const section = page.getByTestId("overview-behavior");
  await expect(section.getByTestId("behavior-none")).toContainText("behaves the same");
  await expect(section.getByTestId("behavior-change")).toHaveCount(0);
});
