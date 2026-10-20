import { test, expect } from "@playwright/test";
import { openPr } from "./helpers";

test("tooltips are the app's own: text, keys as kbd, gone on a press or Escape", async ({ page }) => {
  await openPr(page);
  const toggle = page.getByTestId("topbar-comments");
  await toggle.hover();
  const tip = page.getByTestId("tooltip");
  await expect(tip).toBeVisible();
  await expect(tip).toContainText("Comments, chat and review");
  await expect(tip.locator("kbd")).toHaveText(["m", "c", "r"]);
  // Native titles are gone from what we converted.
  await expect(toggle).not.toHaveAttribute("title", /.+/);

  // Straight on to the next tipped element: no wait, the new text.
  await page.getByTestId("view-units").hover();
  await expect(tip).toContainText("The PR unit by unit");
  await expect(tip.locator("kbd")).toHaveText(["g"]);

  await page.keyboard.press("Escape");
  await expect(tip).toHaveCount(0);

  // A click hides it; it does not come back while the pointer stays.
  await toggle.hover();
  await expect(tip).toBeVisible();
  await toggle.click();
  await expect(tip).toHaveCount(0);
});
