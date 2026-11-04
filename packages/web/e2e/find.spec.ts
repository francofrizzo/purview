import { test, expect } from "@playwright/test";
import { MOD, openPr, scroller } from "./helpers";

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
