import { test, expect } from "@playwright/test";
import { UNITS, hunkHeader, openPr, openUnit } from "./helpers";

test("a finding's evidence opens the places the diff shows and leaves the rest as text", async ({ page }) => {
  await openPr(page);
  await openUnit(page, UNITS.charge);
  const findings = page.getByTestId("unit-findings");
  await findings.getByTestId("findings-toggle").click();
  await expect(findings.getByTestId("findings-toggle")).toContainText("Findings");
  // The fixture's warning cites refund.ts (not in the PR) and ledger.ts:17,
  // inside hunk 0005.
  const evidence = findings.getByTestId("finding-evidence").first();
  await expect(evidence.getByRole("button", { name: /refund\.ts/ })).toHaveCount(0);
  await evidence.getByRole("button", { name: "src/billing/ledger.ts:17" }).click();
  const header = hunkHeader(page, "a1b2c3d4e5f60005");
  await expect(header).toHaveAttribute("data-focused", "true");
  await expect(header).toBeInViewport();
});
