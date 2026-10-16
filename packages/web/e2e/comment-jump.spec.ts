import { test, expect } from "@playwright/test";
import { UNITS, hunkHeader, openPr, openUnit } from "./helpers";

test("a comment in the dock opens its unit, unfolds the hunk and shows the comment on its line", async ({ page }) => {
  await openPr(page);
  await openUnit(page, UNITS.reconcile);
  await page.keyboard.press("m");
  const dock = page.getByTestId("right-dock");
  // draft-1 sits on charge.ts:24, inside hunk 0001 of the charge unit, which
  // the fixture marks viewed (so it is folded).
  await dock.getByTestId("comment-card-draft-1").getByRole("button", { name: /charge\.ts/ }).click();
  await expect(page.getByTestId("unit-header")).toContainText(UNITS.charge);
  const header = hunkHeader(page, "a1b2c3d4e5f60001");
  await expect(header).toHaveAttribute("data-focused", "true");
  await expect(header).not.toHaveAttribute("data-collapsed", "true");
  // One click is enough: the card is on screen, not just rendered somewhere
  // below the fold of the scroller.
  const card = page.locator("[data-diff-scroller]").getByTestId("comment-card-draft-1");
  await expect(card).toBeVisible();
  await expect(card).toBeInViewport({ ratio: 1 });
  await expect(header).toBeInViewport({ ratio: 1 });
});
