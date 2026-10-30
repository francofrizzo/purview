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

test("each end of the move has a band naming the file and lines at the other end, open by default", async ({ page }) => {
  const out = page.getByTestId(band(OUT_REGION));
  const into = page.getByTestId(band(IN_REGION));
  // One band per end: the blank context line inside the old block is bridged,
  // so the two halves there do not get a band each.
  await expect(out).toHaveText(/^8 lines moved to src\/billing\/report\.ts:3–10/);
  await expect(into).toHaveText(/^8 lines moved from src\/billing\/reconcileReport\.ts:3–10/);
  await expect(page.locator('[data-testid^="fold-fold:"]')).toHaveCount(2);
  await expect(out).toHaveAttribute("aria-expanded", "true");
  // Open: the moved rows sit under their bands.
  await expect(movedRows(page, "del")).toHaveCount(7);
  await expect(movedRows(page, "add")).toHaveCount(8);
  // The header badge names the other end's lines too.
  await expect(page.getByTestId(`moved-badge-${OUT}`)).toHaveText("moved → report.ts:3–10");
  await expect(page.getByTestId(`moved-badge-${IN}`)).toHaveText("moved ← reconcileReport.ts:3–10");
});

test("the band stays above the block: clicking it folds the rows away, and again brings them back", async ({ page }) => {
  const out = page.getByTestId(band(OUT_REGION));
  await out.click();
  await expect(out).toHaveAttribute("aria-expanded", "false");
  await expect(movedRows(page, "del")).toHaveCount(0);
  await out.click();
  await expect(out).toBeVisible();
  await expect(out).toHaveAttribute("aria-expanded", "true");
  await expect(movedRows(page, "del")).toHaveCount(7);
});

test("with Moved blocks set to fold shut, blocks open folded and the band opens them", async ({ page }) => {
  await page.addInitScript(() => {
    const raw = localStorage.getItem("reviewer.settings");
    localStorage.setItem("reviewer.settings", JSON.stringify({ ...(raw ? JSON.parse(raw) : {}), foldMovedBlocks: true }));
  });
  await page.reload();
  await openUnit(page, UNIT);
  const into = page.getByTestId(band(IN_REGION));
  await expect(into).toHaveAttribute("aria-expanded", "false");
  await expect(movedRows(page, "del")).toHaveCount(0);
  await expect(movedRows(page, "add")).toHaveCount(0);
  await into.click();
  await expect(movedRows(page, "add")).toHaveCount(8);
  await expect(into).toHaveAttribute("aria-expanded", "true");
});

test("a moved row keeps its side's tint, faded, and swaps +/- for a direction arrow", async ({ page }) => {
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

test("the band's \"go to\" lands on the other end's first line, folded or not", async ({ page }) => {
  await expect(hunkHeader(page, OUT)).toHaveAttribute("data-focused", "true");
  const go = page.getByTestId(jump(OUT_REGION));
  await expect(go).toContainText("go to report.ts:3–10");
  await go.click();
  await expect(hunkHeader(page, IN)).toHaveAttribute("data-focused", "true");
  await expect(page.locator('[data-flash="true"]')).toContainText("function formatMismatch");

  // and back, from the moved-in band, onto the removed line, even with
  // that block folded
  await page.getByTestId(band(OUT_REGION)).click();
  await expect(movedRows(page, "del")).toHaveCount(0);
  await page.getByTestId(jump(IN_REGION)).click();
  await expect(hunkHeader(page, OUT)).toHaveAttribute("data-focused", "true");
  await expect(movedRows(page, "del")).toHaveCount(7);
  await expect(page.locator('[data-flash="true"]')).toContainText("function formatMismatch");
});

test("Enter on the focused band folds it", async ({ page }) => {
  await page.getByTestId(band(IN_REGION)).focus();
  await page.keyboard.press("Enter");
  await expect(movedRows(page, "add")).toHaveCount(0);
});

test("split view: a block that can't fold whole keeps its band, with nothing to fold", async ({ page }) => {
  await page.keyboard.press("d");
  await expect(page.getByTestId("view-split").first()).toHaveAttribute("aria-pressed", "true");
  // The new file's block faces nothing on the left: it folds, whole.
  const into = page.getByTestId(band(IN_REGION));
  await expect(into).toHaveText(/^8 lines moved from/);
  await into.click();
  await expect(movedRows(page, "add")).toHaveCount(0);
  // In the old file the second half pairs with the re-export, a real line:
  // its band names the move but is no toggle, and its rows stay in view.
  const out = page.getByTestId(band(OUT_REGION));
  await expect(out).toHaveText(/^8 lines moved to src\/billing\/report\.ts:3–10/);
  await expect(out).not.toHaveAttribute("aria-expanded", /.*/);
  await out.click();
  await expect(movedRows(page, "del")).toHaveCount(7);
});
