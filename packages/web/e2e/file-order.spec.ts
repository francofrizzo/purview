import { test, expect } from "@playwright/test";
import { openPr, openUnit, UNITS } from "./helpers";

// The fixture's wiring unit lists orders.ts before container.ts; the diff has
// them the other way round, and docs and reconcile.ts are not listed.
test("a unit shows its files in the analysis's reading order, unlisted ones after in diff order", async ({ page }) => {
  await openPr(page);
  await openUnit(page, UNITS.wiring);
  const headers = page.locator("[data-testid^=hunk-header-a1b2c3d4e5f600]");
  await expect(headers).toHaveCount(4);
  const ids = await headers.evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")!.slice(-4)));
  expect(ids).toEqual(["0007", "0006", "0009", "0010"]);
});
