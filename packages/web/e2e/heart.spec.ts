import { test, expect } from "@playwright/test";
import { openPr } from "./helpers";

// The fixture's charge unit has two heart hunks (…0003 first, then …0001,
// which carries two segments) of three; the unit opens selected, heart files
// first: 0003, 0001, then 0005.
const HEART = ["a1b2c3d4e5f60003", "a1b2c3d4e5f60001"];
const SUPPORT = "a1b2c3d4e5f60005";

test("heart hunks are marked, counted in the sidebar, and h/H walk them", async ({ page }) => {
  await openPr(page);
  // The header carries no mark; the captions and the segment rows do.
  for (const id of HEART) {
    await expect(page.getByTestId(`hunk-header-${id}`).locator("xpath=..")).not.toHaveAttribute("data-heart", "true");
    await expect(page.getByTestId(`hunk-heart-${id}`).first()).toBeVisible();
    await expect(page.getByTestId(`hunk-heart-${id}`).first().locator("xpath=..")).toHaveAttribute("data-heart", "true");
  }
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
