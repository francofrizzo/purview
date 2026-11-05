import { test, expect } from "@playwright/test";
import { hunkHeader, MOD, openPr, openUnit, RECONCILE_HUNKS, scroller, UNITS } from "./helpers";

/** Whether the page kept Cmd+F (the diff's find) or left it to the browser. */
async function pressFind(page: import("@playwright/test").Page): Promise<boolean> {
  // Read once every listener has run: the app's may be added after this one.
  await page.evaluate(() => {
    const w = window as unknown as { pressed?: KeyboardEvent };
    w.pressed = undefined;
    addEventListener("keydown", (e) => e.key === "f" && (w.pressed = e), { capture: true });
  });
  await page.keyboard.press(`${MOD}+f`);
  return page.evaluate(() => Boolean((window as unknown as { pressed?: KeyboardEvent }).pressed?.defaultPrevented));
}

test("Cmd+F finds in the diff over the diff, and is the browser's over a panel or pressed again", async ({ page }) => {
  await openPr(page);
  const bar = page.getByTestId("diff-search");

  // Nothing touched yet: the diff is where you are.
  expect(await pressFind(page)).toBe(true);
  await expect(bar).toBeVisible();

  // Again in the find bar: the browser's.
  await expect(page.getByTestId("search-input")).toBeFocused();
  expect(await pressFind(page)).toBe(false);
  await page.getByTestId("search-input").press("Escape");

  // Over the comments panel: the browser's.
  await page.keyboard.press("m");
  await page.getByTestId("right-dock").hover();
  expect(await pressFind(page)).toBe(false);
  await expect(bar).toHaveCount(0);

  // Back over the code: the diff's.
  await scroller(page).hover();
  expect(await pressFind(page)).toBe(true);
  await expect(bar).toBeVisible();
});

test("whole-diff matches go unit by unit, and the cursor waits in a unit the reader opens", async ({ page }) => {
  await openPr(page);
  // The hunks in no unit come last, under no unit header.
  const unitNo = async () => {
    const header = page.getByTestId("unit-header");
    if (!(await header.count())) return Infinity;
    const n = /^\d+/.exec((await header.textContent()) ?? "")?.[0];
    return n ? Number(n) : Infinity;
  };
  const count = page.getByTestId("search-count");
  const input = page.getByTestId("search-input");
  await page.keyboard.press(`${MOD}+f`);
  await page.getByTestId("search-where-all").click();
  await input.fill("ledger");
  await expect(count).toHaveText(/^1\/\d+$/);
  const total = Number((await count.textContent())!.split("/")[1]);

  // In the sidebar's order: the unit number never goes back before the wrap.
  let last = await unitNo();
  for (let i = 2; i <= total; i++) {
    await input.press("Enter");
    await expect(count).toHaveText(`${i}/${total}`);
    const now = await unitNo();
    expect(now).toBeGreaterThanOrEqual(last);
    last = now;
  }

  // Opening another unit leaves the cursor there, not on the match it was on.
  await openUnit(page, UNITS.charge);
  await expect(count).toHaveText(`–/${total}`);
  await input.press("Enter");
  await expect(count).toHaveText(`1/${total}`);
  await expect(page.getByTestId("unit-header")).toContainText(UNITS.charge.slice(0, 30));
});

test("a folded hunk shows its matches, opens for one and folds again after", async ({ page }) => {
  await openPr(page);
  await openUnit(page, UNITS.reconcile);
  const id = RECONCILE_HUNKS[0];
  const header = hunkHeader(page, id);
  // A click folds the focused hunk (the first one is, on entering the unit).
  await expect(header).toHaveAttribute("data-focused", "true");
  await header.click();
  await expect(header).toHaveAttribute("data-collapsed", "true");

  const input = page.getByTestId("search-input");
  await page.keyboard.press(`${MOD}+f`);
  await input.fill("GatewayCharge");
  // The first match is in it: open while the cursor is there…
  await expect(page.getByTestId("search-count")).toHaveText(/^1\//);
  await expect(header).toHaveAttribute("data-collapsed", "false");
  // …folded again once it moves on, with the count of what it holds.
  // Three in this hunk (its field, its interface, verdictFor's argument).
  await expect(page.getByTestId("search-count")).toHaveText(/^1\/([4-9]|\d\d)$/);
  for (const i of [2, 3, 4]) {
    await input.press("Enter");
    await expect(page.getByTestId("search-count")).toHaveText(new RegExp(`^${i}/`));
  }
  await scroller(page).evaluate((el) => (el.scrollTop = 0));
  await expect(header).toHaveAttribute("data-collapsed", "true");
  await expect(header.getByTestId("match-badge")).toBeVisible();
  // Closing the search leaves it as the reader had it.
  await input.press("Escape");
  await expect(header).toHaveAttribute("data-collapsed", "true");
  await expect(header.getByTestId("match-badge")).toHaveCount(0);
});
