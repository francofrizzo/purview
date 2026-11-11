import { test, expect } from "@playwright/test";
import { UNITS, openPr, openUnit } from "./helpers";

test("a unit's diagram shows under its brief without an experiment and opens in the viewer", async ({ page }) => {
  await openPr(page);
  await openUnit(page, UNITS.charge);
  const diagram = page.getByTestId("unit-diagram");
  await expect(diagram).toHaveAttribute("data-kind", "sequence");
  await diagram.getByTestId("unit-diagram-open").click();
  await expect(page.getByTestId("mermaid-modal")).toBeVisible();
  await expect(page.getByTestId("diagram-canvas").locator("svg")).toBeVisible();
});
