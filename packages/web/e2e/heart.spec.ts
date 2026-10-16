import { test, expect } from "@playwright/test";
import { openPr } from "./helpers";

// The fixture's charge unit has two heart hunks (…0003 and …0001) of three;
// the unit opens selected, in diff order: 0001, 0003, 0005.
const HEART = ["a1b2c3d4e5f60001", "a1b2c3d4e5f60003"];
const SUPPORT = "a1b2c3d4e5f60005";

test("heart hunks are marked, counted in the sidebar, and h/H walk them", async ({ page }) => {
  await openPr(page);
  for (const id of HEART) {
    await expect(page.getByTestId(`hunk-header-${id}`).locator("xpath=..")).toHaveAttribute("data-heart", "true");
    await expect(page.getByTestId(`hunk-heart-${id}`)).toBeVisible();
  }
  await expect(page.getByTestId(`hunk-header-${SUPPORT}`).locator("xpath=..")).not.toHaveAttribute("data-heart", "true");
  await expect(page.getByTestId(`hunk-heart-${SUPPORT}`)).toHaveCount(0);

  await expect(page.getByTestId("unit-heart-idempotent-charge-path")).toHaveText("2");
  await expect(page.getByTestId("unit-heart-transient-retry-backoff")).toHaveText("1");
  await expect(page.getByTestId("unit-heart-wiring-and-docs")).toHaveCount(0);

  // The unit opens on its first unviewed hunk (0001 is viewed, so 0003: a
  // heart one); h goes to the next heart hunk, wrapping around at the end,
  // and H walks back.
  await expect(page.getByTestId(`hunk-header-${HEART[1]}`)).toHaveAttribute("data-focused", "true");
  await page.keyboard.press("h");
  await expect(page.getByTestId(`hunk-header-${HEART[0]}`)).toHaveAttribute("data-focused", "true");
  await page.keyboard.press("h");
  await expect(page.getByTestId(`hunk-header-${HEART[1]}`)).toHaveAttribute("data-focused", "true");
  await page.keyboard.press("H");
  await expect(page.getByTestId(`hunk-header-${HEART[0]}`)).toHaveAttribute("data-focused", "true");
  await page.keyboard.press("H");
  // From a support hunk, h picks the next heart hunk after it (wrapping).
  await page.keyboard.press("j");
  await expect(page.getByTestId(`hunk-header-${SUPPORT}`)).toHaveAttribute("data-focused", "true");
  await page.keyboard.press("h");
  await expect(page.getByTestId(`hunk-header-${HEART[0]}`)).toHaveAttribute("data-focused", "true");
});

test("the unit brief lists the heart, and a jump focuses that hunk", async ({ page }) => {
  await openPr(page);
  const brief = page.getByTestId("unit-heart");
  await expect(brief).toBeVisible();
  await expect(brief.getByRole("button")).toHaveCount(2);
  await page.getByTestId(`heart-jump-${HEART[1]}`).click();
  await expect(page.getByTestId(`hunk-header-${HEART[1]}`)).toHaveAttribute("data-focused", "true");
  await expect(page.getByTestId(`hunk-header-${HEART[1]}`)).toBeInViewport();
});
