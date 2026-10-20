import { test, expect } from "@playwright/test";

test("Coding agents offers a selectable install prompt and copies it", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/settings");
  await page.getByTestId("settings-nav-coding-agents").click();
  const section = page.locator("#settings-coding-agents");
  await expect(section.getByRole("heading", { name: "Coding agents" })).toBeVisible();
  const prompt = section.getByRole("textbox", { name: "Paste into your coding agent" });
  await expect(prompt).toHaveValue(/api\/skill\/manifest.json/);
  await expect(prompt).toHaveAttribute("readonly", "");
  const copy = section.getByRole("button", { name: "copy prompt", exact: true });
  await copy.click();
  await expect(copy).toHaveText("Copied");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(await prompt.inputValue());
  await expect(section).toContainText("purview skill install");
});
