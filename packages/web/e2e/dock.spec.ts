import { test, expect } from "@playwright/test";
import { openPr } from "./helpers";

test.beforeEach(async ({ page }) => {
  await openPr(page);
});

test("one dock on the right: comments, chat and review are its tabs, one at a time", async ({ page }) => {
  await expect(page.getByTestId("right-dock")).toHaveCount(0);

  // The header's toggle opens the first tab, the chat, on a fresh page.
  await page.getByTestId("topbar-comments").click();
  const dock = page.getByTestId("right-dock");
  await expect(dock).toHaveAttribute("data-tab", "chat");
  await page.getByTestId("topbar-comments").click();
  await expect(page.getByTestId("right-dock")).toHaveCount(0);

  await page.keyboard.press("m");
  await expect(dock).toHaveAttribute("data-tab", "comments");
  await expect(page.getByTestId("comments-panel")).toBeVisible();

  await page.getByTestId("dock-tab-chat").click();
  await expect(dock).toHaveAttribute("data-tab", "chat");
  await expect(page.getByTestId("chat-panel")).toBeVisible();
  await expect(page.getByTestId("comments-panel")).toHaveCount(0);

  // The chat's input holds the focus, so the key is typed there; the tab is the way.
  await page.getByTestId("dock-tab-review").click();
  await expect(dock).toHaveAttribute("data-tab", "review");
  await expect(page.getByTestId("finish-review-panel")).toBeVisible();
  await expect(page.getByTestId("chat-panel")).toHaveCount(0);

  // The same key on the open tab closes the dock; the X too.
  await page.keyboard.press("r");
  await expect(page.getByTestId("right-dock")).toHaveCount(0);
  // The top bar's toggle reopens the last tab (review), then closes it.
  await page.getByTestId("topbar-comments").click();
  await expect(dock).toHaveAttribute("data-tab", "review");
  await page.getByTestId("topbar-comments").click();
  await expect(page.getByTestId("right-dock")).toHaveCount(0);
  await page.keyboard.press("m");
  await expect(dock).toHaveAttribute("data-tab", "comments");
  await page.getByTestId("dock-close").click();
  await expect(page.getByTestId("right-dock")).toHaveCount(0);

  // "finish review" in the comments tab switches tabs.
  await page.keyboard.press("m");
  await page.getByTestId("drawer-finish-review").click();
  await expect(dock).toHaveAttribute("data-tab", "review");
  // The top bar's finish review button toggles the same tab off.
  await page.getByTestId("topbar-finish-review").click();
  await expect(page.getByTestId("right-dock")).toHaveCount(0);
});
