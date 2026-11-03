import { test, expect } from "@playwright/test";
import { UNITS, hunkHeader, openPr, openUnit } from "./helpers";

test("a finding's evidence opens the places the diff shows and leaves the rest as text", async ({ page }) => {
  await openPr(page);
  await openUnit(page, UNITS.charge);
  await page.getByTestId("findings-toggle").click();
  const findings = page.getByTestId("unit-findings");
  // The fixture's warning cites refund.ts (not in the PR) and ledger.ts:17,
  // inside hunk 0005.
  const evidence = findings.getByTestId("finding-evidence").first();
  await expect(evidence.getByRole("button", { name: /refund\.ts/ })).toHaveCount(0);
  // The file and the line show; the folders are on hover.
  await expect(evidence).toContainText("ledger.ts 17");
  await expect(evidence).not.toContainText("src/billing/");
  await evidence.getByRole("button", { name: "src/billing/ledger.ts:17" }).click();
  const header = hunkHeader(page, "a1b2c3d4e5f60005");
  await expect(header).toHaveAttribute("data-focused", "true");
  await expect(header).toBeInViewport();
});

test("findings show warnings only: a unit whose findings are all notes shows none", async ({ page }) => {
  await openPr(page);
  await openUnit(page, UNITS.charge);
  await page.getByTestId("findings-toggle").click();
  await expect(page.getByTestId("unit-findings").locator("li")).toHaveCount(1);
  await openUnit(page, UNITS.retry);
  await expect(page.getByTestId("unit-brief")).toBeVisible();
  await expect(page.getByTestId("findings-toggle")).toHaveCount(0);
});

test("a warning marks the line it cites in the gutter, with its text on hover", async ({ page }) => {
  await openPr(page);
  await openUnit(page, UNITS.charge);
  const header = hunkHeader(page, "a1b2c3d4e5f60005");
  await header.scrollIntoViewIfNeeded();
  const mark = page.getByTestId("line-warning");
  await expect(mark).toHaveCount(1);
  await expect(mark).toHaveAttribute("data-tip", /refundCharge\(\) still keys off the raw orderId/);
});
