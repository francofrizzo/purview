import { test, expect } from "@playwright/test";
import { hunkHeader, openPr, openUnit } from "./helpers";

// The fixture's one code move (src/mocks/fixture.ts): formatMismatch() and
// formatReport() leave reconcileReport.ts (hunk 0013, moved out) for a new
// report.ts (hunk 0014, moved in) verbatim. A blank line the old file keeps
// as context splits the block in two there, and the re-export that replaces
// it sits right under the second half.
const UNIT = "Report formatting moved into its own module";
const OUT = "a1b2c3d4e5f60013";
const IN = "a1b2c3d4e5f60014";
const OUT_REGION = `${OUT}:out:0`;
const IN_REGION = `${IN}:in:2`;
const band = (region: string) => `fold-fold:${region}`;
const jump = (region: string) => `fold-jump-fold:${region}`;

const movedRows = (page: import("@playwright/test").Page, type: "add" | "del") =>
  page.locator(`[data-type="${type}"][data-moved="true"]`);

test.beforeEach(async ({ page }) => {
  await openPr(page);
  await openUnit(page, UNIT);
});

test("both ends of the move fold behind one band each, naming the other file", async ({ page }) => {
  const out = page.getByTestId(band(OUT_REGION));
  const into = page.getByTestId(band(IN_REGION));
  // One band per end: the blank context line inside the old block is bridged,
  // so the two halves there do not get a band each.
  await expect(out).toHaveText(/^8 lines moved to src\/billing\/report\.ts/);
  await expect(into).toHaveText(/^8 lines moved from src\/billing\/reconcileReport\.ts/);
  await expect(page.locator('[data-testid^="fold-fold:"]')).toHaveCount(2);
  // Folded, no moved row is on screen yet.
  await expect(movedRows(page, "del")).toHaveCount(0);
  await expect(movedRows(page, "add")).toHaveCount(0);
});

test("clicking a band expands it: the rows carry the moved tint, and the fold control folds them back up", async ({ page }) => {
  await page.getByTestId(band(OUT_REGION)).click();
  // 7 removed lines, tinted as moved; the bridged blank line is context.
  await expect(movedRows(page, "del")).toHaveCount(7);
  await expect(page.getByTestId(band(OUT_REGION))).toHaveCount(0);
  const refold = page.getByTestId(`refold-${OUT_REGION}`);
  await expect(refold).toBeVisible();
  await refold.click();
  await expect(page.getByTestId(band(OUT_REGION))).toBeVisible();
  await expect(movedRows(page, "del")).toHaveCount(0);

  // The other end: the same, in violet on the added side.
  await page.getByTestId(band(IN_REGION)).click();
  await expect(movedRows(page, "add")).toHaveCount(8);
  await expect(page.getByTestId(`refold-${IN_REGION}`)).toBeVisible();
});

test("a moved row keeps its side's tint, faded, and swaps +/- for a direction arrow", async ({ page }) => {
  await page.getByTestId(band(OUT_REGION)).click();
  await page.getByTestId(band(IN_REGION)).click();
  const bg = (loc: ReturnType<typeof movedRows>) =>
    loc.first().evaluate((el) => getComputedStyle(el).backgroundColor);
  const alpha = (rgba: string) => Number(rgba.match(/[\d.]+(?=\)$)/)?.[0] ?? 1);
  const out = await bg(movedRows(page, "del"));
  const into = await bg(movedRows(page, "add"));
  // Red on the way out, green on the way in, not one shared hue.
  expect(out).not.toBe(into);
  // Fainter than an ordinary added row (the re-export under the block).
  const plainAdd = await page.locator('[data-type="add"]:not([data-moved])').first().evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(alpha(into)).toBeLessThan(alpha(plainAdd));
  // The marker says it is a move: → for code that left, ← for code that arrived.
  await expect(movedRows(page, "del").first().locator(".diff-marker")).toHaveText("→");
  await expect(movedRows(page, "add").first().locator(".diff-marker")).toHaveText("←");
  // A verbatim move never carries a word-level highlight, even when the diff
  // zips it with an unrelated line next to it (the re-export under the block).
  await expect(movedRows(page, "del").locator(".intra")).toHaveCount(0);
});

test("the band's \"go to\" lands on the other end of the move", async ({ page }) => {
  await expect(hunkHeader(page, OUT)).toHaveAttribute("data-focused", "true");
  const go = page.getByTestId(jump(OUT_REGION));
  await expect(go).toContainText("go to report.ts");
  await go.click();
  await expect(hunkHeader(page, IN)).toHaveAttribute("data-focused", "true");
  // The jump is its own control: the band it sits on is still folded.
  await expect(page.getByTestId(band(OUT_REGION))).toBeVisible();

  // and back, from the moved-in band
  await page.getByTestId(jump(IN_REGION)).click();
  await expect(hunkHeader(page, OUT)).toHaveAttribute("data-focused", "true");
});

test("Enter on the focused band expands it", async ({ page }) => {
  await page.getByTestId(band(IN_REGION)).focus();
  await page.keyboard.press("Enter");
  await expect(movedRows(page, "add")).toHaveCount(8);
});

test("split view: a block folds only when the whole run can — the one facing a real line stays open", async ({ page }) => {
  await page.keyboard.press("d");
  await expect(page.getByTestId("view-split").first()).toHaveAttribute("aria-pressed", "true");
  // The new file's block faces nothing on the left: it folds, whole.
  await expect(page.getByTestId(band(IN_REGION))).toHaveText(/^8 lines moved from/);
  // In the old file the second half pairs with the re-export, a real line:
  // no band at all for that block, not one for the first half either, and
  // its rows stay tinted as moved.
  await expect(page.getByTestId(band(OUT_REGION))).toHaveCount(0);
  await expect(page.locator('[data-testid^="fold-fold:"]')).toHaveCount(1);
  await expect(movedRows(page, "del")).toHaveCount(7);
  await expect(movedRows(page, "add")).toHaveCount(0);
});
