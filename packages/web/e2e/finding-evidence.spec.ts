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

test("a finding copies as a task for an agent", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await openPr(page);
  await openUnit(page, UNITS.charge);
  await page.getByTestId("findings-toggle").click();
  const finding = page.getByTestId("unit-finding").first();
  await finding.hover();
  await finding.getByTestId("finding-copy").click();
  await expect(finding.getByTestId("finding-copy")).toHaveAttribute("data-copied", "1");
  const text = await page.evaluate(() => navigator.clipboard.readText());
  expect(text).toContain("Check it: fix it if it holds");
  expect(text).toContain("Where: ");
  expect(text).toContain("src/billing/ledger.ts:17");
});

test("with finding kinds on, a warning says its kind, and a unit's architecture deviation opens its Overview row", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("reviewer.mockExperiments", "architecture,findingKinds"));
  await openPr(page);
  await openUnit(page, UNITS.charge);
  await page.getByTestId("findings-toggle").click();
  const finding = page.getByTestId("unit-finding").first();
  await expect(finding).toHaveAttribute("data-kind", "bug");
  await expect(finding).toContainText("Possible bug");

  await openUnit(page, UNITS.reconcile);
  const toggle = page.getByTestId("findings-toggle");
  if ((await toggle.getAttribute("aria-expanded")) === "false") await toggle.click();
  const deviation = page.getByTestId("unit-deviation");
  await expect(deviation).toContainText("Reconciler queries the ledger table itself");
  await expect(deviation).toContainText("docs/architecture.md");
  await deviation.getByTestId("unit-deviation-open").click();
  const row = page.getByTestId("overview-architecture").getByTestId("architecture-deviation");
  await expect(row).toHaveAttribute("data-focused", "true");
  await expect(row).toBeInViewport();
});

test("with finding kinds off, a warning shows no kind and a unit no deviation", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("reviewer.mockExperiments", "architecture"));
  await openPr(page);
  await openUnit(page, UNITS.charge);
  await page.getByTestId("findings-toggle").click();
  await expect(page.getByTestId("unit-finding").first()).not.toHaveAttribute("data-kind", /.+/);
  await expect(page.getByTestId("unit-finding").first()).not.toContainText("Possible bug");
  await expect(page.getByTestId("unit-deviation")).toHaveCount(0);
});
