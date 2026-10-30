import { test, expect, type Locator } from "@playwright/test";
import { openPr } from "./helpers";

// The fixture's charge unit has two heart hunks (…0003 first, then …0001,
// which carries two segments) of three; the unit opens selected, heart files
// first: 0003, 0001, then 0005.
const HEART = ["a1b2c3d4e5f60003", "a1b2c3d4e5f60001"];
const SUPPORT = "a1b2c3d4e5f60005";

test("heart hunks are marked, counted in the sidebar, and h/H walk them", async ({ page }) => {
  await openPr(page);
  // An open heart hunk: the header carries no mark; the captions and the
  // segment rows do. A folded one (0001, read) folds its captions with its
  // code and keeps a heart on its header, the whys on hover.
  await expect(page.getByTestId(`hunk-header-${HEART[0]}`).locator("xpath=..")).not.toHaveAttribute("data-heart", "true");
  await expect(page.getByTestId(`hunk-heart-${HEART[0]}`).first()).toBeVisible();
  await expect(page.getByTestId(`hunk-heart-${HEART[0]}`).first().locator("xpath=..")).toHaveAttribute("data-heart", "true");
  await expect(page.getByTestId(`hunk-header-${HEART[1]}`)).toHaveAttribute("data-collapsed", "true");
  await expect(page.getByTestId(`hunk-heart-${HEART[1]}`)).toHaveCount(0);
  await expect(page.getByTestId(`hunk-heart-mark-${HEART[1]}`)).toHaveAttribute("data-tip", /short-circuits on the ledger row/);
  await expect(page.getByTestId(`hunk-header-${SUPPORT}`).locator("xpath=..")).not.toHaveAttribute("data-heart", "true");
  await expect(page.getByTestId(`hunk-heart-${SUPPORT}`)).toHaveCount(0);

  await expect(page.getByTestId("unit-heart-idempotent-charge-path")).toHaveText("2");
  await expect(page.getByTestId("unit-heart-transient-retry-backoff")).toHaveText("1");
  await expect(page.getByTestId("unit-heart-wiring-and-docs")).toHaveCount(0);

  // The unit opens on its first unviewed hunk (0003, the first heart; 0001
  // is viewed). h walks the heart segments: 0001 has two, so it takes two
  // presses to leave it; the list wraps at the end, and H walks back.
  await expect(page.getByTestId(`hunk-header-${HEART[0]}`)).toHaveAttribute("data-focused", "true");
  await page.keyboard.press("h");
  await expect(page.getByTestId(`hunk-header-${HEART[1]}`)).toHaveAttribute("data-focused", "true");
  await page.keyboard.press("h");
  await expect(page.getByTestId(`hunk-header-${HEART[1]}`)).toHaveAttribute("data-focused", "true");
  await expect(page.getByTestId(`hunk-heart-${HEART[1]}`).nth(1)).toBeInViewport();
  await page.keyboard.press("h");
  await expect(page.getByTestId(`hunk-header-${HEART[0]}`)).toHaveAttribute("data-focused", "true");
  await page.keyboard.press("H");
  await expect(page.getByTestId(`hunk-header-${HEART[1]}`)).toHaveAttribute("data-focused", "true");
  await page.keyboard.press("H");
  await expect(page.getByTestId(`hunk-header-${HEART[1]}`)).toHaveAttribute("data-focused", "true");
  await page.keyboard.press("H");
  await expect(page.getByTestId(`hunk-header-${HEART[0]}`)).toHaveAttribute("data-focused", "true");
  // From a support hunk, h picks the next heart segment after it (wrapping).
  await page.keyboard.press("j");
  await page.keyboard.press("j");
  await expect(page.getByTestId(`hunk-header-${SUPPORT}`)).toHaveAttribute("data-focused", "true");
  await page.keyboard.press("h");
  await expect(page.getByTestId(`hunk-header-${HEART[0]}`)).toHaveAttribute("data-focused", "true");
});

test("a heart with a line range bars only those rows, and its brief entry names them", async ({ page }) => {
  await openPr(page);
  // 0001's heart is lines 21-23 (the ledger short-circuit): those rows and
  // the deleted lines they replace carry the bar; the rest of the hunk does not.
  // 0001 is viewed, so it opens folded: unfold it to see its rows.
  await page.getByTestId(`hunk-toggle-${HEART[1]}`).click();
  const row = (text: string) => page.locator("[data-index]", { hasText: text }).first();
  await expect(row("const key = idempotencyKey(order.id")).toHaveAttribute("data-heart", "true");
  await expect(row("if (existing) return existing.result")).toHaveAttribute("data-heart", "true");
  await expect(row("const res = await this.gateway.charge(order.total, order.currency);")).toHaveAttribute("data-heart", "true");
  await expect(row("await this.ledger.record(key, result)")).not.toHaveAttribute("data-heart", "true");
  // The second segment (lines 29-30) is barred too, with its own caption; the
  // lines between the two segments are not.
  await expect(row("await this.ledger.recordFailure(key, res.code)")).toHaveAttribute("data-heart", "true");
  await expect(row("const res = await this.retry(() =>")).not.toHaveAttribute("data-heart", "true");
  // Each segment closes with a rule on its last row, and nowhere else.
  await expect(row("if (existing) return existing.result")).toHaveAttribute("data-heart-end", "true");
  // Line 30 is the second row with this text; the first is the deleted line 22, outside the segment.
  await expect(page.locator("[data-index]", { hasText: "throw new ChargeFailed(res.code);" }).nth(1)).toHaveAttribute("data-heart-end", "true");
  await expect(row("const res = await this.gateway.charge(order.total, order.currency);")).not.toHaveAttribute("data-heart-end", "true");
  await expect(row("await this.ledger.recordFailure(key, res.code)")).not.toHaveAttribute("data-heart-end", "true");
  await expect(page.getByTestId(`heart-jump-${HEART[1]}`).first()).toContainText("charge.ts:21-23");
  await expect(page.getByTestId(`heart-jump-${HEART[1]}`).nth(1)).toContainText("charge.ts:29-30");
  // Each why sits right above its segment's first marked row (for the first,
  // the deleted line the range replaces), not under the header rows up.
  const captionIdx = Number(await page.getByTestId(`hunk-heart-${HEART[1]}`).first().locator("xpath=..").getAttribute("data-index"));
  const firstMarked = Number(await row("const res = await this.gateway.charge(order.total, order.currency);").getAttribute("data-index"));
  expect(firstMarked).toBe(captionIdx + 1);
  const caption2 = Number(await page.getByTestId(`hunk-heart-${HEART[1]}`).nth(1).locator("xpath=..").getAttribute("data-index"));
  const secondMarked = Number(await row("await this.ledger.recordFailure(key, res.code)").getAttribute("data-index"));
  expect(secondMarked).toBe(caption2 + 1);
  const headerIdx = Number(await page.getByTestId(`hunk-header-${HEART[1]}`).locator("xpath=..").getAttribute("data-index"));
  expect(captionIdx).toBeGreaterThan(headerIdx + 1);
  // A whole-hunk heart keeps its why under the header.
  const h0 = Number(await page.getByTestId(`hunk-header-${HEART[0]}`).locator("xpath=..").getAttribute("data-index"));
  expect(Number(await page.getByTestId(`hunk-heart-${HEART[0]}`).first().locator("xpath=..").getAttribute("data-index"))).toBe(h0 + 1);
});

test("the unit brief lists the heart, and a jump focuses that hunk", async ({ page }) => {
  await openPr(page);
  const brief = page.getByTestId("unit-heart");
  await expect(brief).toBeVisible();
  // Three segments across two hunks: one row each.
  await expect(brief.getByRole("button")).toHaveCount(3);
  await page.getByTestId(`heart-jump-${HEART[1]}`).first().click();
  await expect(page.getByTestId(`hunk-header-${HEART[1]}`)).toHaveAttribute("data-focused", "true");
  await expect(page.getByTestId(`hunk-header-${HEART[1]}`)).toBeInViewport();
});

test("a file the PR adds whole reads on the plain ground, its gutter still green, in both views", async ({ page }) => {
  await openPr(page);
  const background = (row: Locator) => row.evaluate((el) => getComputedStyle(el).backgroundColor);
  const line = "Stable key for a charge attempt";
  const transparent = "rgba(0, 0, 0, 0)";

  const unified = page.locator('.diff-line[data-type="add"]').filter({ hasText: line });
  await expect(unified).toHaveCount(1);
  expect(await background(unified)).toBe(transparent);
  expect(await background(unified.locator(".diff-gutter").nth(1))).not.toBe(transparent);

  await page.keyboard.press("d");
  await expect(page.getByTestId("view-split").first()).toHaveAttribute("aria-pressed", "true");
  const split = page.locator('.diff-half[data-type="add"]').filter({ hasText: line });
  await expect(split).toHaveCount(1);
  expect(await background(split)).toBe(transparent);
  expect(await background(split.locator(".diff-gutter"))).not.toBe(transparent);
});
