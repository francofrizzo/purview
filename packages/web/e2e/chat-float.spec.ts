import { expect, test, type Locator, type Page } from "@playwright/test";
import { openPr } from "./helpers";

const VW = 1280;
const VH = 800;

async function popOut(page: Page) {
  await openPr(page);
  await page.keyboard.press("m");
  await page.getByTestId("dock-tab-chat").click();
  await expect(page.getByTestId("chat-panel")).toBeVisible();
  await page.getByTestId("chat-pop-out").click();
  await expect(page.getByTestId("chat-float")).toBeVisible();
}

/** Press on `from`'s centre, move by (dx, dy) in a few steps, release. */
async function drag(page: Page, from: Locator, dx: number, dy: number) {
  const b = (await from.boundingBox())!;
  const x = b.x + b.width / 2;
  const y = b.y + b.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 6 });
  await page.mouse.up();
}

test("the chat pops out of the dock into a window that moves, resizes and stays where it was put", async ({ page }) => {
  await popOut(page);
  const win = page.getByTestId("chat-float");
  // Out of the dock, which had nothing else open, so it closes.
  await expect(page.getByTestId("right-dock")).toHaveCount(0);
  await expect(win.getByTestId("chat-panel")).toBeVisible();
  // It opens in the bottom-right corner.
  const start = (await win.boundingBox())!;
  expect(start.x + start.width).toBeCloseTo(VW - 24, -1);
  expect(start.y + start.height).toBeCloseTo(VH - 24, -1);

  await drag(page, page.getByTestId("chat-float-bar"), -400, -100);
  const moved = (await win.boundingBox())!;
  expect(moved.x).toBeCloseTo(start.x - 400, 0);
  expect(moved.y).toBeCloseTo(start.y - 100, 0);
  expect(moved.width).toBeCloseTo(start.width, 0);

  // The top-left corner grows it up and left; the opposite corner stays put.
  await drag(page, page.getByTestId("chat-float-resize-nw"), -120, -60);
  const grown = (await win.boundingBox())!;
  expect(grown.width).toBeCloseTo(moved.width + 120, 0);
  expect(grown.height).toBeCloseTo(moved.height + 60, 0);
  expect(grown.x + grown.width).toBeCloseTo(moved.x + moved.width, 0);

  // Back on the PR later, `c` opens it floating, where it was left.
  await openPr(page);
  await expect(win).toHaveCount(0);
  await page.keyboard.press("c");
  await expect(win).toBeVisible();
  expect(await win.boundingBox()).toEqual(grown);
  await expect(page.getByTestId("right-dock")).toHaveCount(0);
});

test("minimized, it waits as a pill with the half-typed message; c or the pill brings it back", async ({ page }) => {
  await popOut(page);
  const win = page.getByTestId("chat-float");
  await page.getByTestId("chat-input").fill("half typed");
  await page.getByTestId("chat-float-minimize").click();
  await expect(win).toBeHidden();
  await expect(page.getByTestId("chat-pill")).toBeVisible();

  await page.keyboard.press("c");
  await expect(win).toBeVisible();
  await expect(page.getByTestId("chat-pill")).toHaveCount(0);
  await expect(page.getByTestId("chat-input")).toHaveValue("half typed");
  await expect(page.getByTestId("chat-input")).toBeFocused();

  await page.getByTestId("chat-float-minimize").click();
  await page.getByTestId("chat-pill").click();
  await expect(win).toBeVisible();

  // `c` on the shown window closes it.
  await page.getByTestId("chat-input").blur();
  await page.keyboard.press("c");
  await expect(win).toHaveCount(0);
});

test("floating, the dock is left to comments and review; the dock button takes the chat back in", async ({ page }) => {
  await popOut(page);
  await page.getByTestId("chat-input").blur();
  await page.keyboard.press("m");
  await expect(page.getByTestId("right-dock")).toHaveAttribute("data-tab", "comments");
  await expect(page.getByTestId("chat-float")).toBeVisible();
  // The dock's chat tab says where the chat went.
  await expect(page.getByTestId("dock-chat-floating")).toBeVisible();

  await page.getByTestId("chat-float-dock").click();
  await expect(page.getByTestId("chat-float")).toHaveCount(0);
  await expect(page.getByTestId("right-dock")).toHaveAttribute("data-tab", "chat");
  await expect(page.getByTestId("right-dock").getByTestId("chat-panel")).toBeVisible();
  await expect(page.getByTestId("dock-chat-floating")).toHaveCount(0);
});

test("it stays on screen when the browser window shrinks", async ({ page }) => {
  await popOut(page);
  await page.setViewportSize({ width: 600, height: 420 });
  const win = page.getByTestId("chat-float");
  await expect
    .poll(async () => {
      const b = (await win.boundingBox())!;
      return b.x >= 0 && b.y >= 0 && b.x + b.width <= 600 && b.y + b.height <= 420;
    })
    .toBe(true);
});
