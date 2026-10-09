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
  await expect(hunkHeader(page, B).getByRole("button", { name: "Mark as not viewed (v)" })).toBeVisible();
  await expect(hunkHeader(page, B)).toContainText("lines folded");
  await expectUnderFileHeader(page, C);
  await expect(page.getByTestId("file-header-src/billing/reconcile.ts").first()).toContainText("1/4 viewed");
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
  // The diff follows the unit: its first hunk is focused.
  await expect(hunkHeader(page, "a1b2c3d4e5f60002")).toHaveAttribute("data-focused", "true");
});

test("s toggles the summary strip", async ({ page }) => {
  // Hovering the strip peeks it open too; keep the pointer out of the way.
  await page.mouse.move(8, 792);
  const strip = page.getByTestId("summary-strip");
  await expect(strip).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByTestId("summary-overlay")).toHaveCount(0);

  await page.keyboard.press("s");
  await expect(strip).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByTestId("summary-overlay")).toBeVisible();
  await expect(page.getByTestId("pr-description")).toContainText("Retried charges could double-bill");

  await page.keyboard.press("s");
  await expect(strip).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByTestId("summary-overlay")).toHaveCount(0);
});

test("V marks the whole unit viewed and moves on", async ({ page }) => {
  await page.mouse.move(5, 5);
  await expect(page.getByTestId("unit-header")).toContainText(UNITS.reconcile.slice(0, 30));
  await page.keyboard.press("Shift+KeyV");
  // The unit is done, so the view advances to the next one in sidebar order.
  await expect(page.getByTestId("unit-header")).not.toContainText(UNITS.reconcile.slice(0, 30));
  // The sidebar row is the button that holds the title; its progress reads full.
  const row = page.locator("nav button", { hasText: UNITS.reconcile }).first();
  await expect(row).toContainText("5/5");
});
