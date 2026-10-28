import { expect, test } from "@playwright/test";
import { openPr } from "./helpers";

test.beforeEach(async ({ page }) => {
  await openPr(page);
  await page.keyboard.press("m");
  await page.getByTestId("dock-tab-chat").click();
  await expect(page.getByTestId("chat-panel")).toBeVisible();
});

test("Open in Claude Code works before the first message", async ({ page }) => {
  await expect(page.getByTestId("chat-handoff")).toBeEnabled();
  await page.getByTestId("chat-handoff").click();
  await expect(page.getByTestId("chat-handoff-cwd")).toContainText("/coding/");
});

test("Open in Claude Code shows its coding workspace and copy control above the chat toolbar", async ({ page }) => {
  await page.getByTestId("chat-input").fill("What should I check first?");
  await page.getByTestId("chat-send").click();
  await page.getByTestId("chat-stop").click();
  await expect(page.getByTestId("chat-stopped")).toBeVisible();
  await page.getByTestId("chat-handoff").click();
  const popover = page.getByTestId("chat-handoff-popover");
  await expect(popover).toHaveAccessibleName("Open in Claude Code");
  await expect(page.getByTestId("chat-handoff-command")).toContainText("claude");
  await expect(page.getByTestId("chat-handoff-command")).not.toContainText("--resume");
  await expect(page.getByTestId("chat-handoff-cwd")).toContainText("/coding/");
  await expect(popover).toContainText("purview/fix/482");
  await expect(popover).toContainText("Reviewed commit");
  const box = await popover.boundingBox();
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height).toBeLessThanOrEqual(page.viewportSize()!.height);
  await expect(popover).toContainText("What you do there won't appear here");
  await popover.getByRole("button", { name: "copy", exact: true }).click();
  await expect(popover.getByRole("button", { name: "copied", exact: true })).toBeVisible();
  await page.setViewportSize({ width: 1100, height: 480 });
  const compact = await popover.boundingBox();
  const panel = await page.getByTestId("chat-panel").boundingBox();
  expect(compact!.y).toBeGreaterThanOrEqual(panel!.y);
  expect(compact!.y + compact!.height).toBeLessThanOrEqual(480);
  await page.keyboard.press("Escape");
  await expect(popover).toHaveCount(0);
  await expect(page.getByTestId("chat-panel")).toBeVisible();
});

test("stopping a reply says so until the turn winds down", async ({ page }) => {
  await page.getByTestId("chat-input").fill("What is the riskiest change?");
  await page.getByTestId("chat-send").click();

  const stop = page.getByTestId("chat-stop");
  await expect(stop).toBeVisible();
  await stop.click();
  // The mock's stop takes a moment to land, like the real child exiting.
  await expect(stop).toHaveText(/stopping…/);
  await expect(stop).toBeDisabled();

  await expect(page.getByTestId("chat-stopped")).toBeVisible();
  await expect(page.getByTestId("chat-stop")).toHaveCount(0);
  await expect(page.getByTestId("chat-error")).toHaveCount(0);
});

test("a clear or rewind that fails says so and leaves the transcript alone", async ({ page }) => {
  // "keep" makes the mock refuse to clear or rewind this transcript.
  await page.getByTestId("chat-input").fill("keep this one");
  await page.getByTestId("chat-send").click();
  await expect(page.getByTestId("chat-stop")).toBeVisible();
  await page.getByTestId("chat-stop").click();
  await expect(page.getByTestId("chat-stopped")).toBeVisible();

  await page.getByTestId("chat-rewind-0").click({ force: true });
  await page.getByTestId("chat-rewind-confirm-0").click();
  const error = page.getByTestId("chat-error");
  await expect(error).toContainText("The rewind did not go through");
  await expect(error).toContainText("mock failure");
  await expect(page.getByTestId("chat-panel")).toContainText("keep this one");
  await page.getByTestId("chat-dismiss-failure").click();
  await expect(error).toHaveCount(0);

  await page.getByLabel("Chat settings").click();
  await page.getByRole("button", { name: "clear conversation" }).click();
  await page.getByTestId("chat-clear-confirm").click();
  await expect(error).toContainText("The conversation was not cleared");
  await expect(page.getByTestId("chat-panel")).toContainText("keep this one");
});

test("a reply follows the bottom only while you are there: scrolling up a little stays put", async ({ page }) => {
  const transcript = page.getByTestId("chat-transcript");
  const send = async (text: string) => {
    await page.getByTestId("chat-input").fill(text);
    await page.getByTestId("chat-send").click();
  };
  const distance = () =>
    transcript.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
  // Enough history to scroll.
  for (const q of ["What is the riskiest change?", "And the second riskiest?"]) {
    await send(q);
    await expect(page.getByTestId("chat-stop")).toHaveCount(0, { timeout: 20_000 });
  }
  expect(await transcript.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
  // Pinned: a reply keeps the bottom in view as it streams.
  expect(await distance()).toBeLessThanOrEqual(4);

  await send("Walk me through the retry wrapper.");
  await expect(page.getByTestId("chat-stop")).toBeVisible();
  await transcript.hover();
  await page.mouse.wheel(0, -30);
  await page.waitForTimeout(150);
  const top = await transcript.evaluate((el) => el.scrollTop);
  await page.waitForTimeout(800);
  // Deltas keep arriving, the view does not move.
  expect(await transcript.evaluate((el) => el.scrollTop)).toBe(top);
  await expect(page.getByRole("button", { name: "jump to latest" })).toBeVisible();

  // Back to the bottom, it follows again.
  await page.getByRole("button", { name: "jump to latest" }).click();
  await expect(page.getByRole("button", { name: "jump to latest" })).toHaveCount(0);
  await expect(page.getByTestId("chat-stop")).toHaveCount(0, { timeout: 20_000 });
  expect(await distance()).toBeLessThanOrEqual(4);
});
