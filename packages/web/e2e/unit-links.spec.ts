import { test, expect } from "@playwright/test";
import { openPr, openUnit, UNITS } from "./helpers";

test("a unit id in a brief reads as that unit's title and opens it", async ({ page }) => {
  await openPr(page);
  await openUnit(page, UNITS.wiring);
  const header = page.getByTestId("unit-header");
  // The fixture's wiring summary names `idempotent-charge-path`; the reader
  // sees the unit's number and title, never the id.
  const link = header.getByRole("button", { name: new RegExp(UNITS.charge) });
  await expect(link).toBeVisible();
  await expect(header).not.toContainText("idempotent-charge-path");
  await link.click();
  await expect(header).toContainText(UNITS.charge);
});
