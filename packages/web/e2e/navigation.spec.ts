import { test, expect } from "@playwright/test";
import { RECONCILE_HUNKS, UNITS, expectUnderFileHeader, hunkHeader, openPr, openUnit } from "./helpers";

const [A, B, C] = RECONCILE_HUNKS;

test.beforeEach(async ({ page }) => {
  await openPr(page);
  await openUnit(page, UNITS.reconcile);
});

test("j/k move the focus one hunk at a time and land it under the sticky file header", async ({ page }) => {
  await expect(hunkHeader(page, A)).toHaveAttribute("data-focused", "true");

  await page.keyboard.press("j");
  await expectUnderFileHeader(page, B);
  // Exactly one focused hunk (A's row may have left the virtual window).
  await expect(page.locator('[data-testid^=hunk-header-][data-focused="true"]')).toHaveCount(1);
  // The pinned row above it is this file's header, not a hunk's.
  await expect(page.locator('[data-sticky="true"] [data-testid="file-header-src/billing/reconcile.ts"]')).toBeVisible();

  await page.keyboard.press("j");
  await expectUnderFileHeader(page, C);

  await page.keyboard.press("k");
  await expectUnderFileHeader(page, B);
});

test("v marks the focused hunk viewed, folds it, and moves on to the next", async ({ page }) => {
  await page.keyboard.press("j");
  await expectUnderFileHeader(page, B);

  await page.keyboard.press("v");
  await expect(hunkHeader(page, B)).toHaveAttribute("data-collapsed", "true");
  await expect(hunkHeader(page, B).getByRole("button", { name: "Mark as not viewed" })).toBeVisible();
  await expect(hunkHeader(page, B)).toContainText("lines folded");
  await expectUnderFileHeader(page, C);
  // The file's own checkbox now reads partly done.
  await expect(page.getByTestId("file-viewed-src/billing/reconcile.ts").first()).toHaveAttribute("aria-checked", "mixed");
});

test("a unit opens on its first hunk still to read, and v moves on to the next one still to read", async ({ page }) => {
  // The charge unit: 0001 is viewed in the fixture, 0003 and 0005 are not.
  await openUnit(page, UNITS.charge);
  await expect(hunkHeader(page, "a1b2c3d4e5f60003")).toHaveAttribute("data-focused", "true");
  await page.keyboard.press("v");
  await expect(hunkHeader(page, "a1b2c3d4e5f60003")).toHaveAttribute("data-collapsed", "true");
  await expect(hunkHeader(page, "a1b2c3d4e5f60005")).toHaveAttribute("data-focused", "true");
});

test("Shift+J / Shift+K step between units in sidebar order", async ({ page }) => {
  await expect(page.getByTestId("unit-header")).toContainText(UNITS.reconcile);
  // The reconciliation unit is "skim" and sits after the two must-reads.
  await page.keyboard.press("Shift+KeyK");
  await expect(page.getByTestId("unit-header")).toContainText(UNITS.retry);
  await page.keyboard.press("Shift+KeyK");
  await expect(page.getByTestId("unit-header")).toContainText(UNITS.charge);
  await page.keyboard.press("Shift+KeyJ");
  await expect(page.getByTestId("unit-header")).toContainText(UNITS.retry);
  // The diff follows the unit: its first hunk still to read is focused
  // (0002 is already viewed in the fixture).
  await expect(hunkHeader(page, "a1b2c3d4e5f60008")).toHaveAttribute("data-focused", "true");
});

test("s opens the overview; a piece of the flow leads to the unit that changes it", async ({ page }) => {
  await page.keyboard.press("s");
  const overview = page.getByTestId("overview");
  await expect(overview).toBeVisible();
  await expect(page.getByTestId("view-overview")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("pr-summary")).toBeVisible();
  await expect(page.getByTestId("pr-description")).toContainText("Retried charges could double-bill");
  // Only what needs a close read is listed; the rest is counted.
  const reading = page.getByTestId("reading-order");
  await expect(reading).toContainText(UNITS.charge);
  await expect(reading).not.toContainText(UNITS.reconcile);
  await expect(page.getByTestId("reading-rest")).toHaveText("Then 2 to skim and 2 to skip.");

  // How it runs: the path in order, the cut call still drawn beside the new one.
  const flow = page.getByTestId("flow-view");
  await expect(flow).toContainText("findByKey(key)");
  await expect(flow).toContainText("authorize(charge)");
  await page.locator('[data-flow-participant="retry"]').click();
  await expect(overview).toHaveCount(0);
  await expect(page.getByTestId("unit-header")).toContainText(UNITS.retry);

  await page.keyboard.press("s");
  await expect(overview).toBeVisible();
  await page.keyboard.press("g");
  await expect(overview).toHaveCount(0);
  await expect(page.getByTestId("view-units")).toHaveAttribute("aria-pressed", "true");
});

test("V marks the whole unit viewed and moves on", async ({ page }) => {
  await page.mouse.move(5, 5);
  await expect(page.getByTestId("unit-header")).toContainText(UNITS.reconcile.slice(0, 30));
  await page.keyboard.press("Shift+KeyV");
  // The unit is done, so the view advances to the next one in sidebar order.
  await expect(page.getByTestId("unit-header")).not.toContainText(UNITS.reconcile.slice(0, 30));
  // The row's own box reads fully viewed.
  await expect(page.getByTestId("unit-viewed-ledger-reconciliation")).toHaveAttribute("aria-checked", "true");
});

test("a unit's box marks it all viewed from its row, and unmarks it", async ({ page }) => {
  const box = page.getByTestId("unit-viewed-transient-retry-backoff");
  // Retry has one of its two hunks viewed in the fixture.
  await expect(box).toHaveAttribute("aria-checked", "mixed");
  await box.click();
  await expect(box).toHaveAttribute("aria-checked", "true");
  // Not the open unit: marking it does not move the reader.
  await expect(page.getByTestId("unit-header")).toContainText(UNITS.reconcile.slice(0, 30));
  await box.click();
  await expect(box).toHaveAttribute("aria-checked", "false");
});

test("the revision menu lights up what a revision changed", async ({ page }) => {
  await page.getByTestId("revision-menu").click();
  const r3 = page.getByTestId("highlight-revision-3");
  await expect(r3).toHaveAttribute("aria-pressed", "false");
  await r3.click();
  await expect(page.getByTestId("highlight-summary")).toBeVisible();
  // The sidebar marks the units that revision touched.
  await expect(page.locator('[data-testid^="unit-changed-"]').first()).toHaveAttribute("data-tip", "Changed in r3");
  // The menu may have closed on the scroll the highlight caused; reopened, it shows r3 on.
  const menu = page.getByTestId("revision-menu");
  if ((await menu.getAttribute("aria-expanded")) !== "true") await menu.click();
  await expect(page.getByTestId("highlight-revision-3")).toHaveAttribute("aria-pressed", "true");
  await page.getByTestId("highlight-revision-3").click();
  await expect(page.getByTestId("highlight-summary")).toHaveCount(0);
});

test("space / shift+space step between the hunks still to read, skipping viewed ones", async ({ page }) => {
  // The charge unit: 0001 is viewed in the fixture, 0003 and 0005 are not.
  await openUnit(page, UNITS.charge);
  await expect(hunkHeader(page, "a1b2c3d4e5f60003")).toHaveAttribute("data-focused", "true");
  await page.keyboard.press("Space");
  await expect(hunkHeader(page, "a1b2c3d4e5f60005")).toHaveAttribute("data-focused", "true");
  await page.keyboard.press("Shift+Space");
  await expect(hunkHeader(page, "a1b2c3d4e5f60003")).toHaveAttribute("data-focused", "true");
  // From the first one still to read, backward wraps to the last.
  await page.keyboard.press("Shift+Space");
  await expect(hunkHeader(page, "a1b2c3d4e5f60005")).toHaveAttribute("data-focused", "true");
});

test("where it lands: the files as a tree with their notes, a file opens in the Files view", async ({ page }) => {
  await page.keyboard.press("s");
  // The key says what the marks are: new files, the rest changed.
  await expect(page.getByTestId("file-legend")).toContainText(/\+\s*\d+ new/);
  await expect(page.getByTestId("file-legend")).toContainText("changed");
  const files = page.getByTestId("file-shape");
  await expect(files).toContainText("Derives the charge key from order id");
  await expect(files).toContainText("generated files");
  await page.getByTestId("file-shape-src/billing/ledger.ts").click();
  await expect(page.getByTestId("overview")).toHaveCount(0);
  await expect(page.getByTestId("view-files")).toHaveAttribute("aria-pressed", "true");
});

test("a step of the flow says which unit it opens, and opens it; one that names none is inert", async ({ page }) => {
  await page.keyboard.press("s");
  // findByKey(key): a new step, made by the idempotent charge path.
  const step = page.locator('[data-flow-step="2"]');
  await expect(step).toHaveAttribute("data-tip", /^Opens \d+\. Idempotent charge path/);
  // The gateway's answer is as before and names no unit: no tip to repeat its label.
  await expect(page.locator('[data-flow-step="7"]')).not.toHaveAttribute("data-tip", /.*/);
  await step.click();
  await expect(page.getByTestId("overview")).toHaveCount(0);
  await expect(page.getByTestId("unit-header")).toContainText(UNITS.charge);
});

test("the view tabs stay put when switching views, so the pointer doesn't have to chase them", async ({ page }) => {
  const xs: number[] = [];
  for (const key of ["s", "g", "f"]) {
    await page.keyboard.press(key);
    await expect(page.getByTestId("view-overview")).toBeVisible();
    xs.push((await page.getByTestId("view-overview").boundingBox())!.x);
  }
  expect(Math.max(...xs) - Math.min(...xs)).toBeLessThanOrEqual(0.5);
  // In the overview the button keeps only what applies there: no diff options.
  await page.keyboard.press("s");
  await page.getByTestId("view-options").click();
  await expect(page.getByTestId("layout-unified")).toHaveCount(0);
});

test("a risk shows on the row only where the analysis says to skim or skip", async ({ page }) => {
  // The reconciliation unit is a skim that makes an external call: worth knowing before skimming it.
  await expect(page.getByTestId("unit-risk-ledger-reconciliation")).toHaveText("external call");
  await expect(page.getByTestId("unit-risk-ledger-reconciliation")).toHaveAttribute("data-tip", "Skim, but a risk surface: external call");
  // A must-read unit gets read anyway, and its why says the risk in words.
  await expect(page.getByTestId("unit-risk-idempotent-charge-path")).toHaveCount(0);
});
